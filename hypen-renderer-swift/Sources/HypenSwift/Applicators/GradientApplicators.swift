import SwiftUI

// MARK: - Linear Gradient Applicator

/// Applicator for linear gradient background.
/// Supports both:
/// - Object format: linearGradient({colors: ["red", "blue"], angle: 45})
/// - CSS-like string: linearGradient("to right, #3b82f6, #8b5cf6") or linearGradient("135deg, #color1, #color2")
public struct LinearGradientApplicator: ApplicatorHandler {
    public let name = "linearGradient"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        // Try string format first (CSS-like)
        if let stringValue = value as? String {
            if let gradient = parseGradientString(stringValue) {
                modifier.backgroundGradient = AnyShapeStyle(gradient)
            }
            return
        }

        // Fall back to object format
        guard let map = value as? [String: Any],
              let colorsList = map["colors"] as? [Any] else { return }

        let colors = colorsList.compactMap { ColorParser.parse($0) }
        guard colors.count >= 2 else { return }

        let angle = (map["angle"] as? NSNumber)?.floatValue ?? 0
        let gradient = createGradient(colors: colors, angle: angle)
        modifier.backgroundGradient = AnyShapeStyle(gradient)
    }

    private func parseGradientString(_ value: String) -> LinearGradient? {
        // Parse CSS-like gradient string: "to right, #color1, #color2" or "135deg, #color1, #color2"
        let components = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard components.count >= 2 else { return nil }

        var angle: Float = 0
        var colorStrings: [String] = []

        let first = components[0].lowercased()

        // Parse direction or angle
        if first.hasPrefix("to ") {
            // Direction keywords
            let direction = first.dropFirst(3)
            switch direction {
            case "right":
                angle = 90
            case "left":
                angle = 270
            case "bottom":
                angle = 180
            case "top":
                angle = 0
            case "bottom right", "right bottom":
                angle = 135
            case "bottom left", "left bottom":
                angle = 225
            case "top right", "right top":
                angle = 45
            case "top left", "left top":
                angle = 315
            default:
                angle = 90
            }
            colorStrings = Array(components.dropFirst()).map { String($0) }
        } else if first.hasSuffix("deg") {
            // Angle in degrees
            let angleStr = first.dropLast(3)
            angle = Float(angleStr) ?? 0
            colorStrings = Array(components.dropFirst()).map { String($0) }
        } else {
            // No direction/angle specified, treat all as colors
            angle = 90  // Default to left-to-right
            colorStrings = components.map { String($0) }
        }

        let colors = colorStrings.compactMap { ColorParser.parse($0) }
        guard colors.count >= 2 else { return nil }

        return createGradient(colors: colors, angle: angle)
    }

    private func createGradient(colors: [Color], angle: Float) -> LinearGradient {
        // Convert CSS angle to SwiftUI coordinates
        // CSS: 0deg = to top, 90deg = to right, 180deg = to bottom, 270deg = to left
        let normalizedAngle = Int(angle) % 360

        switch normalizedAngle {
        case 0:
            return LinearGradient(colors: colors, startPoint: .bottom, endPoint: .top)
        case 90:
            return LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
        case 180:
            return LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
        case 270:
            return LinearGradient(colors: colors, startPoint: .trailing, endPoint: .leading)
        case 45:
            return LinearGradient(colors: colors, startPoint: .bottomLeading, endPoint: .topTrailing)
        case 135:
            return LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
        case 225:
            return LinearGradient(colors: colors, startPoint: .topTrailing, endPoint: .bottomLeading)
        case 315:
            return LinearGradient(colors: colors, startPoint: .bottomTrailing, endPoint: .topLeading)
        default:
            // For other angles, calculate start/end points
            let radians = Double(angle) * .pi / 180
            let startX = 0.5 - cos(radians) * 0.5
            let startY = 0.5 + sin(radians) * 0.5
            let endX = 0.5 + cos(radians) * 0.5
            let endY = 0.5 - sin(radians) * 0.5
            return LinearGradient(
                colors: colors,
                startPoint: UnitPoint(x: startX, y: startY),
                endPoint: UnitPoint(x: endX, y: endY)
            )
        }
    }
}

// MARK: - Radial Gradient Applicator

/// Applicator for radial gradient background.
/// Supports: radialGradient({colors: ["red", "blue"], radius: 100})
public struct RadialGradientApplicator: ApplicatorHandler {
    public let name = "radialGradient"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let map = value as? [String: Any],
              let colorsList = map["colors"] as? [Any] else { return }

        let colors = colorsList.compactMap { ColorParser.parse($0) }
        guard colors.count >= 2 else { return }

        let gradient = RadialGradient(
            colors: colors,
            center: .center,
            startRadius: 0,
            endRadius: 200
        )

        modifier.backgroundGradient = AnyShapeStyle(gradient)
    }
}

// MARK: - Conic/Sweep Gradient Applicator

/// Applicator for sweep/conic gradient background.
public struct ConicGradientApplicator: ApplicatorHandler {
    public let name = "conicGradient"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let map = value as? [String: Any],
              let colorsList = map["colors"] as? [Any] else { return }

        let colors = colorsList.compactMap { ColorParser.parse($0) }
        guard colors.count >= 2 else { return }

        let gradient = AngularGradient(
            colors: colors,
            center: .center
        )

        modifier.backgroundGradient = AnyShapeStyle(gradient)
    }
}

// MARK: - Generic Gradient Applicator

/// Applicator for gradient (generic).
/// Supports: gradient({type: "linear", colors: [...], angle: 45})
public struct GradientApplicator: ApplicatorHandler {
    public let name = "gradient"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let map = value as? [String: Any],
              let colorsList = map["colors"] as? [Any] else { return }

        let colors = colorsList.compactMap { ColorParser.parse($0) }
        guard colors.count >= 2 else { return }

        let type = (map["type"] as? String)?.lowercased() ?? "linear"

        switch type {
        case "linear":
            let angle = (map["angle"] as? NSNumber)?.floatValue ?? 0
            let gradient: LinearGradient
            switch Int(angle) % 360 {
            case 0, 360:
                gradient = LinearGradient(colors: colors, startPoint: .bottom, endPoint: .top)
            case 90:
                gradient = LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
            case 180:
                gradient = LinearGradient(colors: colors.reversed(), startPoint: .bottom, endPoint: .top)
            case 270:
                gradient = LinearGradient(colors: colors.reversed(), startPoint: .leading, endPoint: .trailing)
            default:
                gradient = LinearGradient(colors: colors, startPoint: .bottom, endPoint: .top)
            }
            modifier.backgroundGradient = AnyShapeStyle(gradient)

        case "radial":
            let gradient = RadialGradient(
                colors: colors,
                center: .center,
                startRadius: 0,
                endRadius: 200
            )
            modifier.backgroundGradient = AnyShapeStyle(gradient)

        case "sweep", "conic":
            let gradient = AngularGradient(colors: colors, center: .center)
            modifier.backgroundGradient = AnyShapeStyle(gradient)

        default:
            let gradient = LinearGradient(colors: colors, startPoint: .bottom, endPoint: .top)
            modifier.backgroundGradient = AnyShapeStyle(gradient)
        }
    }
}

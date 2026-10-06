import SwiftUI

/// Utility for parsing color values from Hypen props
public enum ColorParser {
    /// Parse a color from various formats
    public static func parse(_ value: Any?) -> Color? {
        guard let value = value else { return nil }

        // Handle string formats
        if let str = value as? String {
            return parseString(str)
        }

        // Handle dictionary format: { "r": 255, "g": 0, "b": 0, "a": 1.0 }
        if let dict = value as? [String: Any] {
            return parseDictionary(dict)
        }

        // Handle array format: [255, 0, 0] or [255, 0, 0, 255]
        if let array = value as? [Any] {
            return parseArray(array)
        }

        return nil
    }

    private static func parseString(_ str: String) -> Color? {
        let trimmed = str.trimmingCharacters(in: .whitespaces).lowercased()

        // Check for named colors
        if let namedColor = namedColors[trimmed] {
            return namedColor
        }

        // Check for hex format
        if trimmed.hasPrefix("#") {
            return parseHex(String(trimmed.dropFirst()))
        }

        // Check for rgb/rgba format
        if trimmed.hasPrefix("rgb") {
            return parseRGBFunction(trimmed)
        }

        // Check for hsl/hsla format
        if trimmed.hasPrefix("hsl") {
            return parseHSLFunction(trimmed)
        }

        // Try parsing as hex without #
        if trimmed.count == 3 || trimmed.count == 6 || trimmed.count == 8 {
            return parseHex(trimmed)
        }

        return nil
    }

    private static func parseHex(_ hex: String) -> Color? {
        var hexString = hex
        var alpha: Double = 1.0

        // Expand shorthand hex (#RGB -> #RRGGBB)
        if hexString.count == 3 {
            hexString = hexString.map { "\($0)\($0)" }.joined()
        }

        // Handle alpha channel
        if hexString.count == 8 {
            let alphaHex = String(hexString.suffix(2))
            hexString = String(hexString.prefix(6))
            if let alphaInt = UInt8(alphaHex, radix: 16) {
                alpha = Double(alphaInt) / 255.0
            }
        }

        guard hexString.count == 6,
              let rgb = UInt64(hexString, radix: 16) else {
            return nil
        }

        let r = Double((rgb >> 16) & 0xFF) / 255.0
        let g = Double((rgb >> 8) & 0xFF) / 255.0
        let b = Double(rgb & 0xFF) / 255.0

        return Color(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }

    // Compiled once; NSRegularExpression is immutable and thread-safe.
    // Matches rgb(r, g, b) or rgba(r, g, b, a).
    nonisolated(unsafe) private static let rgbRegex =
        try? NSRegularExpression(pattern: #"rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)"#)
    // Matches hsl(h, s%, l%) or hsla(h, s%, l%, a).
    nonisolated(unsafe) private static let hslRegex =
        try? NSRegularExpression(pattern: #"hsla?\s*\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*(?:,\s*([\d.]+))?\s*\)"#)

    private static func parseRGBFunction(_ str: String) -> Color? {
        guard let regex = rgbRegex,
              let match = regex.firstMatch(in: str, range: NSRange(str.startIndex..., in: str)) else {
            return nil
        }

        func extractValue(_ index: Int) -> String? {
            guard let range = Range(match.range(at: index), in: str) else { return nil }
            return String(str[range])
        }

        guard let rStr = extractValue(1), let r = Double(rStr),
              let gStr = extractValue(2), let g = Double(gStr),
              let bStr = extractValue(3), let b = Double(bStr) else {
            return nil
        }

        let alpha: Double
        if let aStr = extractValue(4), let a = Double(aStr) {
            alpha = a > 1 ? a / 255.0 : a
        } else {
            alpha = 1.0
        }

        return Color(.sRGB, red: r / 255.0, green: g / 255.0, blue: b / 255.0, opacity: alpha)
    }

    private static func parseHSLFunction(_ str: String) -> Color? {
        guard let regex = hslRegex,
              let match = regex.firstMatch(in: str, range: NSRange(str.startIndex..., in: str)) else {
            return nil
        }

        func extractValue(_ index: Int) -> String? {
            guard let range = Range(match.range(at: index), in: str) else { return nil }
            return String(str[range])
        }

        guard let hStr = extractValue(1), let h = Double(hStr),
              let sStr = extractValue(2), let s = Double(sStr),
              let lStr = extractValue(3), let l = Double(lStr) else {
            return nil
        }

        let alpha: Double
        if let aStr = extractValue(4), let a = Double(aStr) {
            alpha = a > 1 ? a / 255.0 : a
        } else {
            alpha = 1.0
        }

        return Color(hue: h / 360.0, saturation: s / 100.0, brightness: l / 100.0, opacity: alpha)
    }

    private static func parseDictionary(_ dict: [String: Any]) -> Color? {
        let r = (dict["r"] as? Double ?? dict["red"] as? Double ?? 0) / 255.0
        let g = (dict["g"] as? Double ?? dict["green"] as? Double ?? 0) / 255.0
        let b = (dict["b"] as? Double ?? dict["blue"] as? Double ?? 0) / 255.0
        let a = dict["a"] as? Double ?? dict["alpha"] as? Double ?? 1.0

        return Color(.sRGB, red: r, green: g, blue: b, opacity: a > 1 ? a / 255.0 : a)
    }

    private static func parseArray(_ array: [Any]) -> Color? {
        guard array.count >= 3 else { return nil }

        let values = array.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard values.count >= 3 else { return nil }

        let r = values[0] / 255.0
        let g = values[1] / 255.0
        let b = values[2] / 255.0
        let a = values.count > 3 ? (values[3] > 1 ? values[3] / 255.0 : values[3]) : 1.0

        return Color(.sRGB, red: r, green: g, blue: b, opacity: a)
    }

    // MARK: - Named Colors

    private static let namedColors: [String: Color] = [
        // Basic colors
        "black": .black,
        "white": .white,
        "red": .red,
        "green": .green,
        "blue": .blue,
        "yellow": .yellow,
        "orange": .orange,
        "purple": .purple,
        "pink": .pink,
        "brown": .brown,
        "gray": .gray,
        "grey": .gray,
        "cyan": .cyan,
        "mint": .mint,
        "teal": .teal,
        "indigo": .indigo,

        // CSS colors
        "transparent": .clear,
        "clear": .clear,
        "aliceblue": Color(.sRGB, red: 0.94, green: 0.97, blue: 1.0, opacity: 1),
        "antiquewhite": Color(.sRGB, red: 0.98, green: 0.92, blue: 0.84, opacity: 1),
        "aqua": Color(.sRGB, red: 0, green: 1, blue: 1, opacity: 1),
        "aquamarine": Color(.sRGB, red: 0.50, green: 1, blue: 0.83, opacity: 1),
        "azure": Color(.sRGB, red: 0.94, green: 1, blue: 1, opacity: 1),
        "beige": Color(.sRGB, red: 0.96, green: 0.96, blue: 0.86, opacity: 1),
        "bisque": Color(.sRGB, red: 1, green: 0.89, blue: 0.77, opacity: 1),
        "blanchedalmond": Color(.sRGB, red: 1, green: 0.92, blue: 0.80, opacity: 1),
        "blueviolet": Color(.sRGB, red: 0.54, green: 0.17, blue: 0.89, opacity: 1),
        "burlywood": Color(.sRGB, red: 0.87, green: 0.72, blue: 0.53, opacity: 1),
        "cadetblue": Color(.sRGB, red: 0.37, green: 0.62, blue: 0.63, opacity: 1),
        "chartreuse": Color(.sRGB, red: 0.50, green: 1, blue: 0, opacity: 1),
        "chocolate": Color(.sRGB, red: 0.82, green: 0.41, blue: 0.12, opacity: 1),
        "coral": Color(.sRGB, red: 1, green: 0.50, blue: 0.31, opacity: 1),
        "cornflowerblue": Color(.sRGB, red: 0.39, green: 0.58, blue: 0.93, opacity: 1),
        "cornsilk": Color(.sRGB, red: 1, green: 0.97, blue: 0.86, opacity: 1),
        "crimson": Color(.sRGB, red: 0.86, green: 0.08, blue: 0.24, opacity: 1),
        "darkblue": Color(.sRGB, red: 0, green: 0, blue: 0.55, opacity: 1),
        "darkcyan": Color(.sRGB, red: 0, green: 0.55, blue: 0.55, opacity: 1),
        "darkgoldenrod": Color(.sRGB, red: 0.72, green: 0.53, blue: 0.04, opacity: 1),
        "darkgray": Color(.sRGB, red: 0.66, green: 0.66, blue: 0.66, opacity: 1),
        "darkgreen": Color(.sRGB, red: 0, green: 0.39, blue: 0, opacity: 1),
        "darkkhaki": Color(.sRGB, red: 0.74, green: 0.72, blue: 0.42, opacity: 1),
        "darkmagenta": Color(.sRGB, red: 0.55, green: 0, blue: 0.55, opacity: 1),
        "darkolivegreen": Color(.sRGB, red: 0.33, green: 0.42, blue: 0.18, opacity: 1),
        "darkorange": Color(.sRGB, red: 1, green: 0.55, blue: 0, opacity: 1),
        "darkorchid": Color(.sRGB, red: 0.60, green: 0.20, blue: 0.80, opacity: 1),
        "darkred": Color(.sRGB, red: 0.55, green: 0, blue: 0, opacity: 1),
        "darksalmon": Color(.sRGB, red: 0.91, green: 0.59, blue: 0.48, opacity: 1),
        "darkseagreen": Color(.sRGB, red: 0.56, green: 0.74, blue: 0.56, opacity: 1),
        "darkslateblue": Color(.sRGB, red: 0.28, green: 0.24, blue: 0.55, opacity: 1),
        "darkslategray": Color(.sRGB, red: 0.18, green: 0.31, blue: 0.31, opacity: 1),
        "darkturquoise": Color(.sRGB, red: 0, green: 0.81, blue: 0.82, opacity: 1),
        "darkviolet": Color(.sRGB, red: 0.58, green: 0, blue: 0.83, opacity: 1),
        "deeppink": Color(.sRGB, red: 1, green: 0.08, blue: 0.58, opacity: 1),
        "deepskyblue": Color(.sRGB, red: 0, green: 0.75, blue: 1, opacity: 1),
        "dimgray": Color(.sRGB, red: 0.41, green: 0.41, blue: 0.41, opacity: 1),
        "dodgerblue": Color(.sRGB, red: 0.12, green: 0.56, blue: 1, opacity: 1),
        "firebrick": Color(.sRGB, red: 0.70, green: 0.13, blue: 0.13, opacity: 1),
        "floralwhite": Color(.sRGB, red: 1, green: 0.98, blue: 0.94, opacity: 1),
        "forestgreen": Color(.sRGB, red: 0.13, green: 0.55, blue: 0.13, opacity: 1),
        "fuchsia": Color(.sRGB, red: 1, green: 0, blue: 1, opacity: 1),
        "gainsboro": Color(.sRGB, red: 0.86, green: 0.86, blue: 0.86, opacity: 1),
        "ghostwhite": Color(.sRGB, red: 0.97, green: 0.97, blue: 1, opacity: 1),
        "gold": Color(.sRGB, red: 1, green: 0.84, blue: 0, opacity: 1),
        "goldenrod": Color(.sRGB, red: 0.85, green: 0.65, blue: 0.13, opacity: 1),
        "greenyellow": Color(.sRGB, red: 0.68, green: 1, blue: 0.18, opacity: 1),
        "honeydew": Color(.sRGB, red: 0.94, green: 1, blue: 0.94, opacity: 1),
        "hotpink": Color(.sRGB, red: 1, green: 0.41, blue: 0.71, opacity: 1),
        "indianred": Color(.sRGB, red: 0.80, green: 0.36, blue: 0.36, opacity: 1),
        "ivory": Color(.sRGB, red: 1, green: 1, blue: 0.94, opacity: 1),
        "khaki": Color(.sRGB, red: 0.94, green: 0.90, blue: 0.55, opacity: 1),
        "lavender": Color(.sRGB, red: 0.90, green: 0.90, blue: 0.98, opacity: 1),
        "lavenderblush": Color(.sRGB, red: 1, green: 0.94, blue: 0.96, opacity: 1),
        "lawngreen": Color(.sRGB, red: 0.49, green: 0.99, blue: 0, opacity: 1),
        "lemonchiffon": Color(.sRGB, red: 1, green: 0.98, blue: 0.80, opacity: 1),
        "lightblue": Color(.sRGB, red: 0.68, green: 0.85, blue: 0.90, opacity: 1),
        "lightcoral": Color(.sRGB, red: 0.94, green: 0.50, blue: 0.50, opacity: 1),
        "lightcyan": Color(.sRGB, red: 0.88, green: 1, blue: 1, opacity: 1),
        "lightgoldenrodyellow": Color(.sRGB, red: 0.98, green: 0.98, blue: 0.82, opacity: 1),
        "lightgray": Color(.sRGB, red: 0.83, green: 0.83, blue: 0.83, opacity: 1),
        "lightgreen": Color(.sRGB, red: 0.56, green: 0.93, blue: 0.56, opacity: 1),
        "lightpink": Color(.sRGB, red: 1, green: 0.71, blue: 0.76, opacity: 1),
        "lightsalmon": Color(.sRGB, red: 1, green: 0.63, blue: 0.48, opacity: 1),
        "lightseagreen": Color(.sRGB, red: 0.13, green: 0.70, blue: 0.67, opacity: 1),
        "lightskyblue": Color(.sRGB, red: 0.53, green: 0.81, blue: 0.98, opacity: 1),
        "lightslategray": Color(.sRGB, red: 0.47, green: 0.53, blue: 0.60, opacity: 1),
        "lightsteelblue": Color(.sRGB, red: 0.69, green: 0.77, blue: 0.87, opacity: 1),
        "lightyellow": Color(.sRGB, red: 1, green: 1, blue: 0.88, opacity: 1),
        "lime": Color(.sRGB, red: 0, green: 1, blue: 0, opacity: 1),
        "limegreen": Color(.sRGB, red: 0.20, green: 0.80, blue: 0.20, opacity: 1),
        "linen": Color(.sRGB, red: 0.98, green: 0.94, blue: 0.90, opacity: 1),
        "magenta": Color(.sRGB, red: 1, green: 0, blue: 1, opacity: 1),
        "maroon": Color(.sRGB, red: 0.50, green: 0, blue: 0, opacity: 1),
        "mediumaquamarine": Color(.sRGB, red: 0.40, green: 0.80, blue: 0.67, opacity: 1),
        "mediumblue": Color(.sRGB, red: 0, green: 0, blue: 0.80, opacity: 1),
        "mediumorchid": Color(.sRGB, red: 0.73, green: 0.33, blue: 0.83, opacity: 1),
        "mediumpurple": Color(.sRGB, red: 0.58, green: 0.44, blue: 0.86, opacity: 1),
        "mediumseagreen": Color(.sRGB, red: 0.24, green: 0.70, blue: 0.44, opacity: 1),
        "mediumslateblue": Color(.sRGB, red: 0.48, green: 0.41, blue: 0.93, opacity: 1),
        "mediumspringgreen": Color(.sRGB, red: 0, green: 0.98, blue: 0.60, opacity: 1),
        "mediumturquoise": Color(.sRGB, red: 0.28, green: 0.82, blue: 0.80, opacity: 1),
        "mediumvioletred": Color(.sRGB, red: 0.78, green: 0.08, blue: 0.52, opacity: 1),
        "midnightblue": Color(.sRGB, red: 0.10, green: 0.10, blue: 0.44, opacity: 1),
        "mintcream": Color(.sRGB, red: 0.96, green: 1, blue: 0.98, opacity: 1),
        "mistyrose": Color(.sRGB, red: 1, green: 0.89, blue: 0.88, opacity: 1),
        "moccasin": Color(.sRGB, red: 1, green: 0.89, blue: 0.71, opacity: 1),
        "navajowhite": Color(.sRGB, red: 1, green: 0.87, blue: 0.68, opacity: 1),
        "navy": Color(.sRGB, red: 0, green: 0, blue: 0.50, opacity: 1),
        "oldlace": Color(.sRGB, red: 0.99, green: 0.96, blue: 0.90, opacity: 1),
        "olive": Color(.sRGB, red: 0.50, green: 0.50, blue: 0, opacity: 1),
        "olivedrab": Color(.sRGB, red: 0.42, green: 0.56, blue: 0.14, opacity: 1),
        "orangered": Color(.sRGB, red: 1, green: 0.27, blue: 0, opacity: 1),
        "orchid": Color(.sRGB, red: 0.85, green: 0.44, blue: 0.84, opacity: 1),
        "palegoldenrod": Color(.sRGB, red: 0.93, green: 0.91, blue: 0.67, opacity: 1),
        "palegreen": Color(.sRGB, red: 0.60, green: 0.98, blue: 0.60, opacity: 1),
        "paleturquoise": Color(.sRGB, red: 0.69, green: 0.93, blue: 0.93, opacity: 1),
        "palevioletred": Color(.sRGB, red: 0.86, green: 0.44, blue: 0.58, opacity: 1),
        "papayawhip": Color(.sRGB, red: 1, green: 0.94, blue: 0.84, opacity: 1),
        "peachpuff": Color(.sRGB, red: 1, green: 0.85, blue: 0.73, opacity: 1),
        "peru": Color(.sRGB, red: 0.80, green: 0.52, blue: 0.25, opacity: 1),
        "plum": Color(.sRGB, red: 0.87, green: 0.63, blue: 0.87, opacity: 1),
        "powderblue": Color(.sRGB, red: 0.69, green: 0.88, blue: 0.90, opacity: 1),
        "rosybrown": Color(.sRGB, red: 0.74, green: 0.56, blue: 0.56, opacity: 1),
        "royalblue": Color(.sRGB, red: 0.25, green: 0.41, blue: 0.88, opacity: 1),
        "saddlebrown": Color(.sRGB, red: 0.55, green: 0.27, blue: 0.07, opacity: 1),
        "salmon": Color(.sRGB, red: 0.98, green: 0.50, blue: 0.45, opacity: 1),
        "sandybrown": Color(.sRGB, red: 0.96, green: 0.64, blue: 0.38, opacity: 1),
        "seagreen": Color(.sRGB, red: 0.18, green: 0.55, blue: 0.34, opacity: 1),
        "seashell": Color(.sRGB, red: 1, green: 0.96, blue: 0.93, opacity: 1),
        "sienna": Color(.sRGB, red: 0.63, green: 0.32, blue: 0.18, opacity: 1),
        "silver": Color(.sRGB, red: 0.75, green: 0.75, blue: 0.75, opacity: 1),
        "skyblue": Color(.sRGB, red: 0.53, green: 0.81, blue: 0.92, opacity: 1),
        "slateblue": Color(.sRGB, red: 0.42, green: 0.35, blue: 0.80, opacity: 1),
        "slategray": Color(.sRGB, red: 0.44, green: 0.50, blue: 0.56, opacity: 1),
        "snow": Color(.sRGB, red: 1, green: 0.98, blue: 0.98, opacity: 1),
        "springgreen": Color(.sRGB, red: 0, green: 1, blue: 0.50, opacity: 1),
        "steelblue": Color(.sRGB, red: 0.27, green: 0.51, blue: 0.71, opacity: 1),
        "tan": Color(.sRGB, red: 0.82, green: 0.71, blue: 0.55, opacity: 1),
        "thistle": Color(.sRGB, red: 0.85, green: 0.75, blue: 0.85, opacity: 1),
        "tomato": Color(.sRGB, red: 1, green: 0.39, blue: 0.28, opacity: 1),
        "turquoise": Color(.sRGB, red: 0.25, green: 0.88, blue: 0.82, opacity: 1),
        "violet": Color(.sRGB, red: 0.93, green: 0.51, blue: 0.93, opacity: 1),
        "wheat": Color(.sRGB, red: 0.96, green: 0.87, blue: 0.70, opacity: 1),
        "whitesmoke": Color(.sRGB, red: 0.96, green: 0.96, blue: 0.96, opacity: 1),
        "yellowgreen": Color(.sRGB, red: 0.60, green: 0.80, blue: 0.20, opacity: 1),

        // System colors (semantic)
        "primary": .primary,
        "secondary": .secondary,
        "accent": .accentColor,
    ]
}

import SwiftUI

/// Parser for CSS `background` / `background-image` values.
///
/// Mirrors `hypen-renderer-android`'s `CssBackground.kt` — same layer model,
/// same paren/quote-aware splitting, same degradation rules. The engine
/// lowers Tailwind and raw CSS straight onto the wire, so a renderer gets
/// real CSS strings:
///
/// ```
/// backgroundImage.0 = linear-gradient(to bottom right, #818cf8, #7c3aed)
/// background.0      = linear-gradient(180deg, rgba(3,7,18,.08), rgba(3,7,18,.6)),
///                     url('data:image/png;base64,…') center / cover no-repeat
/// ```
///
/// Both used to be dropped: `background` only accepted a flat colour, and
/// `backgroundImage` stored the raw string as a URL (a gradient is not a
/// URL). That is why the home-screen example had no wallpaper and no icon
/// tiles.
///
/// Splitting is the whole difficulty: a layer list is comma-separated, but
/// so are `rgba(3, 7, 18, 0.6)` and the stops inside `linear-gradient(...)`.
public enum CssBackground {

    /// One image or gradient layer from a `background` value.
    public enum PaintLayer {
        case image(String)
        case gradient(GradientSpec)
    }

    /// A gradient as DECLARED, resolved to a concrete style at paint time.
    ///
    /// Radial gradients need the draw size (SwiftUI's `endRadius` is in
    /// points, not a fraction), so the spec is carried rather than a
    /// pre-baked style. Typing this as `LinearGradient` is what previously
    /// forced `radial-gradient(...)` to render as a linear ramp — the wrong
    /// shape, and a divergence from Android, which has always used a true
    /// `Brush.radialGradient`.
    public enum GradientSpec {
        case linear(LinearGradient)
        case radial([Color])
        case conic([Color])
    }

    /// One parsed `background` value, decomposed into paintable layers.
    public struct Layers {
        /// Solid colour layer. CSS always paints `background-color` bottom-most.
        public var color: Color?

        /// Image and gradient layers in PAINT order (bottom first) — CSS
        /// declaration order reversed.
        ///
        /// These share one ordered list rather than separate image/gradient
        /// fields because CSS interleaves them: `url(…), linear-gradient(…)`
        /// paints the IMAGE on top, the exact reverse of
        /// `linear-gradient(…), url(…)`. Separate fields forced a fixed
        /// image-then-gradient order and silently mis-stacked the first form.
        public var paintLayers: [PaintLayer] = []

        /// First image URI in declaration order, for hosts that want to fetch
        /// a remote one themselves.
        public var imageUri: String? {
            for layer in paintLayers.reversed() {
                if case .image(let uri) = layer { return uri }
            }
            return nil
        }

        /// Gradient layers, bottom-first.
        public var gradients: [GradientSpec] {
            paintLayers.compactMap { if case .gradient(let g) = $0 { return g } else { return nil } }
        }

        public var isEmpty: Bool { color == nil && paintLayers.isEmpty }
    }

    /// Default CSS gradient direction is `to bottom`.
    private static let defaultAngle: Float = 180

    /// Parse a `background` / `backgroundImage` value. Returns nil when
    /// nothing in it is expressible, so the caller leaves the modifier
    /// untouched rather than rendering a wrong background.
    public static func parse(_ value: Any?) -> Layers? {
        guard let text = value as? String, !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            return nil
        }

        var layers = Layers()
        var declared: [PaintLayer] = []

        for raw in splitTopLevel(text) {
            let layer = raw.trimmingCharacters(in: .whitespaces)
            if layer.isEmpty { continue }
            let lower = layer.lowercased()

            if lower.contains("url(") {
                // `url('…') center / cover no-repeat` — the trailing
                // position/size/repeat keywords aren't expressible as
                // modifiers, and `cover` is what we do anyway (fill+clip).
                if let uri = extractUrl(layer) { declared.append(.image(uri)) }
            } else if lower.hasPrefix("linear-gradient(") {
                if let gradient = parseLinearGradient(layer) { declared.append(.gradient(.linear(gradient))) }
            } else if lower.hasPrefix("radial-gradient(") {
                let colors = gradientColors(splitTopLevel(inner(of: layer)))
                if colors.count >= 2 { declared.append(.gradient(.radial(colors))) }
            } else if lower.hasPrefix("conic-gradient(") {
                let colors = gradientColors(splitTopLevel(inner(of: layer)))
                if colors.count >= 2 { declared.append(.gradient(.conic(colors))) }
            } else if lower == "none" {
                continue
            } else if layers.color == nil {
                layers.color = ColorParser.parse(layer)
            }
        }

        // CSS paints the first-declared layer on top; store bottom-first so
        // callers can stack them in order.
        layers.paintLayers = declared.reversed()
        return layers.isEmpty ? nil : layers
    }

    /// Split on commas that are not nested inside parentheses or quotes.
    /// Base64 `url(data:…)` payloads and `rgba(...)` stops both need this.
    public static func splitTopLevel(_ value: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var depth = 0
        var quote: Character?

        for ch in value {
            if let q = quote {
                current.append(ch)
                if ch == q { quote = nil }
            } else if ch == "'" || ch == "\"" {
                current.append(ch)
                quote = ch
            } else if ch == "(" {
                depth += 1
                current.append(ch)
            } else if ch == ")" {
                if depth > 0 { depth -= 1 }
                current.append(ch)
            } else if ch == "," && depth == 0 {
                parts.append(current)
                current = ""
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty { parts.append(current) }
        return parts
    }

    /// Contents between the first `(` and the matching final `)`.
    private static func inner(of function: String) -> String {
        guard let open = function.firstIndex(of: "("),
              let close = function.lastIndex(of: ")"),
              function.index(after: open) <= close
        else { return "" }
        return String(function[function.index(after: open)..<close])
    }

    /// `url('…')` / `url(…)` → the bare URI.
    private static func extractUrl(_ layer: String) -> String? {
        guard let range = layer.range(of: "url(", options: .caseInsensitive) else { return nil }
        var depth = 1
        var index = range.upperBound
        while index < layer.endIndex, depth > 0 {
            if layer[index] == "(" { depth += 1 }
            if layer[index] == ")" {
                depth -= 1
                if depth == 0 { break }
            }
            index = layer.index(after: index)
        }
        guard depth == 0 else { return nil }
        let uri = String(layer[range.upperBound..<index])
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "'\""))
        return uri.isEmpty ? nil : uri
    }

    /// `linear-gradient(<direction>?, <stop>, <stop>…)`.
    private static func parseLinearGradient(_ function: String) -> LinearGradient? {
        let parts = splitTopLevel(inner(of: function))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }

        let head = parts[0].lowercased()
        var angle = defaultAngle
        var stops = parts

        if head.hasPrefix("to ") {
            angle = directionToAngle(head)
            stops = Array(parts.dropFirst())
        } else if head.hasSuffix("deg") {
            angle = Float(head.dropLast(3).trimmingCharacters(in: .whitespaces)) ?? defaultAngle
            stops = Array(parts.dropFirst())
        }

        let colors = gradientColors(stops)
        guard colors.count >= 2 else { return nil }
        return createGradient(colors: colors, angle: angle)
    }

    /// Stops may carry a position (`#fff 40%`); the colour is the leading
    /// token. Positions are dropped — an uneven ramp is a nicety, not
    /// correctness.
    private static func gradientColors(_ stops: [String]) -> [Color] {
        stops.compactMap { stop in
            let token = stop.trimmingCharacters(in: .whitespaces)
            if let color = ColorParser.parse(token) { return color }
            guard let space = token.lastIndex(of: " ") else { return nil }
            return ColorParser.parse(String(token[token.startIndex..<space]))
        }
    }

    /// CSS angles: 0deg points up, growing clockwise.
    private static func directionToAngle(_ direction: String) -> Float {
        let normalized = direction.split(separator: " ").joined(separator: " ")
        switch normalized {
        case "to top": return 0
        case "to right": return 90
        case "to bottom": return 180
        case "to left": return 270
        case "to top right", "to right top": return 45
        case "to bottom right", "to right bottom": return 135
        case "to bottom left", "to left bottom": return 225
        case "to top left", "to left top": return 315
        default: return defaultAngle
        }
    }

    /// CSS angle → SwiftUI start/end points. Shared with the
    /// `.linearGradient()` applicator so both trace the same ramp.
    public static func createGradient(colors: [Color], angle: Float) -> LinearGradient {
        switch ((Int(angle) % 360) + 360) % 360 {
        case 0: return LinearGradient(colors: colors, startPoint: .bottom, endPoint: .top)
        case 90: return LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
        case 180: return LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
        case 270: return LinearGradient(colors: colors, startPoint: .trailing, endPoint: .leading)
        case 45: return LinearGradient(colors: colors, startPoint: .bottomLeading, endPoint: .topTrailing)
        case 135: return LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
        case 225: return LinearGradient(colors: colors, startPoint: .topTrailing, endPoint: .bottomLeading)
        case 315: return LinearGradient(colors: colors, startPoint: .bottomTrailing, endPoint: .topLeading)
        default:
            // CSS 0deg points UP and grows clockwise, so the gradient's
            // direction vector is (sin θ, −cos θ) in screen coordinates
            // (y grows downward). Using cos for x and sin for y mirrors the
            // angle about the 45° diagonal — `30deg` rendered as `60deg`.
            let radians = Double(angle) * .pi / 180
            let dx = sin(radians) * 0.5
            let dy = cos(radians) * 0.5
            return LinearGradient(
                colors: colors,
                startPoint: UnitPoint(x: 0.5 - dx, y: 0.5 + dy),
                endPoint: UnitPoint(x: 0.5 + dx, y: 0.5 - dy)
            )
        }
    }

    // MARK: - Data-URI images

    /// Decode a `data:` image URI, memoised by URI.
    ///
    /// The home-screen wallpaper is a ~700 KB base64 PNG that would
    /// otherwise be decoded on every applicator pass. Remote URLs are NOT
    /// fetched here — that needs an async loader, so they degrade to "no
    /// image" rather than blocking rendering on the network.
    @MainActor
    public static func decodeDataImage(_ uri: String) -> Image? {
        guard uri.lowercased().hasPrefix("data:") else { return nil }
        if let cached = imageCache[uri] { return cached }

        var decoded: Image?
        if let comma = uri.firstIndex(of: ","),
           uri[uri.startIndex..<comma].lowercased().contains("base64"),
           let data = Data(
               base64Encoded: String(uri[uri.index(after: comma)...]),
               options: .ignoreUnknownCharacters
           ) {
            #if canImport(UIKit)
            decoded = UIImage(data: data).map { Image(uiImage: $0) }
            #elseif canImport(AppKit)
            decoded = NSImage(data: data).map { Image(nsImage: $0) }
            #endif
        }

        // Cache misses too: a payload that failed once fails every time, and
        // re-attempting a 700 KB decode per frame is the expensive mistake.
        if imageCache.count >= maxCachedImages, let oldest = imageCacheOrder.first {
            imageCache.removeValue(forKey: oldest)
            imageCacheOrder.removeFirst()
        }
        imageCache[uri] = decoded
        imageCacheOrder.append(uri)
        return decoded
    }

    private static let maxCachedImages = 8
    @MainActor private static var imageCache: [String: Image?] = [:]
    @MainActor private static var imageCacheOrder: [String] = []
}

/// Paints parsed CSS background layers, bottom-up.
///
/// A ZStack rather than chained `.background(...)` calls because the layers
/// are dynamic in count, and because CSS's first-declared-on-top ordering
/// maps directly onto ZStack's last-child-on-top once `Layers` has already
/// reversed them.
struct CssBackgroundView: View {
    let layers: CssBackground.Layers
    /// The element's separate `background-color` longhand, if any. CSS
    /// composites it below every layer the `background-image` stack paints.
    var baseColor: Color?
    let cornerRadius: CGFloat

    var body: some View {
        ZStack {
            if let baseColor { baseColor }

            if let color = layers.color { color }

            // Bottom-first, so ZStack's last-child-on-top matches CSS's
            // first-declared-on-top. Images and gradients interleave here
            // exactly as declared.
            ForEach(Array(layers.paintLayers.enumerated()), id: \.offset) { _, layer in
                switch layer {
                case .gradient(let spec):
                    switch spec {
                    case .linear(let gradient):
                        gradient
                    case .conic(let colors):
                        AngularGradient(colors: colors, center: .center)
                    case .radial(let colors):
                        // CSS's default `farthest-corner`: the radius reaches
                        // the box corner, so it needs the measured size.
                        GeometryReader { geo in
                            RadialGradient(
                                colors: colors,
                                center: .center,
                                startRadius: 0,
                                endRadius: hypot(geo.size.width, geo.size.height) / 2
                            )
                        }
                    }
                case .image(let uri):
                    if let image = CssBackground.decodeDataImage(uri) {
                        // `center / cover`: fill the box and crop the
                        // overflow. The clip keeps a 3x-oversized wallpaper
                        // from painting outside its element.
                        GeometryReader { geometry in
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: geometry.size.width, height: geometry.size.height)
                                .clipped()
                        }
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }
}

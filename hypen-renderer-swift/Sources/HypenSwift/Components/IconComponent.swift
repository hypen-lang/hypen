import SwiftUI

/// Renders a server-resolved icon from pre-resolved SVG path data.
///
/// The engine resolves `Icon("heart")` into concrete SVG paths at render time,
/// injecting `__iconPaths` and `__iconViewBox` props. This component reads those
/// pre-resolved props and draws the icon using SwiftUI `Path`.
public struct IconComponent: ComponentHandler {
    public let typeName = "icon"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Read pre-resolved icon data injected by the engine
        let iconPaths = context.element.props["__iconPaths"] as? [[String: Any]]
            ?? context.element.props["__iconPaths.0"] as? [[String: Any]]

        let viewBoxStr = context.element.getStringProp("__iconViewBox.0")
            ?? context.element.getStringProp("__iconViewBox")
            ?? "0 0 24 24"

        // Route through `parseCGFloat` so unit-bearing strings (`"24pt"`,
        // `"16sp"`, `"24dp"`, `"16px"`) resolve the same way they do for
        // font/padding applicators. `getCGFloatProp` uses `Double(str)`,
        // which drops any value with a suffix and silently falls through
        // to the default 24.
        let size = parseCGFloat(context.element.props["size.0"])
            ?? parseCGFloat(context.element.props["size"])
            ?? 24

        let colorStr = context.element.getStringProp("color.0")
            ?? context.element.getStringProp("color")

        let color: Color = colorStr.flatMap { ColorParser.parse($0) } ?? .primary

        // Parse viewBox
        let viewBox = parseViewBox(viewBoxStr)

        if let paths = iconPaths, !paths.isEmpty {
            // Use modifier-supplied size if present, otherwise the size prop default.
            // Clear width/height on the modifier copy so hypenModifier doesn't
            // re-apply a frame over the Canvas (double-framing clips stroke width).
            let effectiveSize = modifier.width ?? modifier.height ?? size
            var strippedModifier = modifier
            strippedModifier.width = nil
            strippedModifier.height = nil

            // Parse paths eagerly into Sendable value types so the Canvas
            // draw closure doesn't capture [String: Any].
            let parsed = paths.map { IconPathData(dict: $0) }

            return AnyView(
                IconCanvasView(
                    paths: parsed,
                    viewBox: viewBox,
                    tint: color
                )
                .frame(width: effectiveSize, height: effectiveSize)
                .hypenModifier(strippedModifier)
            )
        } else {
            // Fallback: show icon name as text if not resolved
            let name = context.element.getStringProp("0")
                ?? context.element.getStringProp("name")
                ?? "?"
            return AnyView(
                Text(name)
                    .font(.system(size: size * 0.6))
                    .frame(width: size, height: size)
                    .foregroundColor(color)
                    .hypenModifier(modifier)
            )
        }
    }

    private func parseViewBox(_ str: String) -> CGRect {
        let parts = str.split(separator: " ").compactMap { Double($0) }
        if parts.count == 4 {
            return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        }
        return CGRect(x: 0, y: 0, width: 24, height: 24)
    }
}

/// A SwiftUI Shape that draws SVG path data.
private struct IconShape: Shape, @unchecked Sendable {
    let paths: [[String: Any]]
    let viewBox: CGRect

    func path(in rect: CGRect) -> Path {
        var combinedPath = Path()

        let scaleX = rect.width / viewBox.width
        let scaleY = rect.height / viewBox.height

        for pathData in paths {
            guard let d = pathData["d"] as? String else { continue }
            if let svgPath = parseSVGPath(d) {
                var transform = CGAffineTransform(scaleX: scaleX, y: scaleY)
                if let scaledPath = svgPath.copy(using: &transform) {
                    combinedPath.addPath(Path(scaledPath))
                }
            }
        }

        return combinedPath
    }

    /// Parse an SVG path `d` attribute into a CGPath.
    fileprivate static func parseSVGPathStatic(_ d: String) -> CGPath? {
        parseSVGPathImpl(d)
    }

    private func parseSVGPath(_ d: String) -> CGPath? {
        Self.parseSVGPathImpl(d)
    }

    fileprivate static func parseSVGPathImpl(_ d: String) -> CGPath? {
        let path = CGMutablePath()
        var currentPoint = CGPoint.zero
        var lastControlPoint: CGPoint?
        var lastCommand: Character = " "

        let tokens = tokenizeSVGPath(d)
        var i = 0

        while i < tokens.count {
            let token = tokens[i]

            if let command = token.first, command.isLetter {
                lastCommand = command
                i += 1

                switch command {
                case "M":
                    if i + 1 < tokens.count, let x = Double(tokens[i]), let y = Double(tokens[i + 1]) {
                        path.move(to: CGPoint(x: x, y: y))
                        currentPoint = CGPoint(x: x, y: y)
                        i += 2
                    }
                case "m":
                    if i + 1 < tokens.count, let dx = Double(tokens[i]), let dy = Double(tokens[i + 1]) {
                        let pt = CGPoint(x: currentPoint.x + dx, y: currentPoint.y + dy)
                        path.move(to: pt)
                        currentPoint = pt
                        i += 2
                    }
                case "L":
                    if i + 1 < tokens.count, let x = Double(tokens[i]), let y = Double(tokens[i + 1]) {
                        path.addLine(to: CGPoint(x: x, y: y))
                        currentPoint = CGPoint(x: x, y: y)
                        i += 2
                    }
                case "l":
                    if i + 1 < tokens.count, let dx = Double(tokens[i]), let dy = Double(tokens[i + 1]) {
                        let pt = CGPoint(x: currentPoint.x + dx, y: currentPoint.y + dy)
                        path.addLine(to: pt)
                        currentPoint = pt
                        i += 2
                    }
                case "H":
                    if let x = Double(tokens[i]) {
                        path.addLine(to: CGPoint(x: x, y: currentPoint.y))
                        currentPoint.x = CGFloat(x)
                        i += 1
                    }
                case "h":
                    if let dx = Double(tokens[i]) {
                        currentPoint.x += CGFloat(dx)
                        path.addLine(to: currentPoint)
                        i += 1
                    }
                case "V":
                    if let y = Double(tokens[i]) {
                        path.addLine(to: CGPoint(x: currentPoint.x, y: y))
                        currentPoint.y = CGFloat(y)
                        i += 1
                    }
                case "v":
                    if let dy = Double(tokens[i]) {
                        currentPoint.y += CGFloat(dy)
                        path.addLine(to: currentPoint)
                        i += 1
                    }
                case "C":
                    if i + 5 < tokens.count,
                       let x1 = Double(tokens[i]), let y1 = Double(tokens[i + 1]),
                       let x2 = Double(tokens[i + 2]), let y2 = Double(tokens[i + 3]),
                       let x = Double(tokens[i + 4]), let y = Double(tokens[i + 5])
                    {
                        let cp1 = CGPoint(x: x1, y: y1)
                        let cp2 = CGPoint(x: x2, y: y2)
                        let end = CGPoint(x: x, y: y)
                        path.addCurve(to: end, control1: cp1, control2: cp2)
                        lastControlPoint = cp2
                        currentPoint = end
                        i += 6
                    }
                case "c":
                    if i + 5 < tokens.count,
                       let dx1 = Double(tokens[i]), let dy1 = Double(tokens[i + 1]),
                       let dx2 = Double(tokens[i + 2]), let dy2 = Double(tokens[i + 3]),
                       let dx = Double(tokens[i + 4]), let dy = Double(tokens[i + 5])
                    {
                        let cp1 = CGPoint(x: currentPoint.x + dx1, y: currentPoint.y + dy1)
                        let cp2 = CGPoint(x: currentPoint.x + dx2, y: currentPoint.y + dy2)
                        let end = CGPoint(x: currentPoint.x + dx, y: currentPoint.y + dy)
                        path.addCurve(to: end, control1: cp1, control2: cp2)
                        lastControlPoint = cp2
                        currentPoint = end
                        i += 6
                    }
                case "S":
                    if i + 3 < tokens.count,
                       let x2 = Double(tokens[i]), let y2 = Double(tokens[i + 1]),
                       let x = Double(tokens[i + 2]), let y = Double(tokens[i + 3])
                    {
                        let cp1 = reflectControlPoint(lastControlPoint, current: currentPoint)
                        let cp2 = CGPoint(x: x2, y: y2)
                        let end = CGPoint(x: x, y: y)
                        path.addCurve(to: end, control1: cp1, control2: cp2)
                        lastControlPoint = cp2
                        currentPoint = end
                        i += 4
                    }
                case "s":
                    if i + 3 < tokens.count,
                       let dx2 = Double(tokens[i]), let dy2 = Double(tokens[i + 1]),
                       let dx = Double(tokens[i + 2]), let dy = Double(tokens[i + 3])
                    {
                        let cp1 = reflectControlPoint(lastControlPoint, current: currentPoint)
                        let cp2 = CGPoint(x: currentPoint.x + dx2, y: currentPoint.y + dy2)
                        let end = CGPoint(x: currentPoint.x + dx, y: currentPoint.y + dy)
                        path.addCurve(to: end, control1: cp1, control2: cp2)
                        lastControlPoint = cp2
                        currentPoint = end
                        i += 4
                    }
                case "Q":
                    if i + 3 < tokens.count,
                       let x1 = Double(tokens[i]), let y1 = Double(tokens[i + 1]),
                       let x = Double(tokens[i + 2]), let y = Double(tokens[i + 3])
                    {
                        let cp = CGPoint(x: x1, y: y1)
                        let end = CGPoint(x: x, y: y)
                        path.addQuadCurve(to: end, control: cp)
                        lastControlPoint = cp
                        currentPoint = end
                        i += 4
                    }
                case "q":
                    if i + 3 < tokens.count,
                       let dx1 = Double(tokens[i]), let dy1 = Double(tokens[i + 1]),
                       let dx = Double(tokens[i + 2]), let dy = Double(tokens[i + 3])
                    {
                        let cp = CGPoint(x: currentPoint.x + dx1, y: currentPoint.y + dy1)
                        let end = CGPoint(x: currentPoint.x + dx, y: currentPoint.y + dy)
                        path.addQuadCurve(to: end, control: cp)
                        lastControlPoint = cp
                        currentPoint = end
                        i += 4
                    }
                case "A", "a":
                    // Elliptical arc: rx ry x-axis-rotation large-arc-flag sweep-flag x y.
                    // SVG arcs are converted to cubic beziers per W3C SVG 1.1 Appendix F.6
                    // so the magnifying-glass / rounded-square heroicons render as real
                    // curves instead of straight-line stubs.
                    let isRelative = command == "a"
                    while i + 6 < tokens.count,
                          let rx = Double(tokens[i]),
                          let ry = Double(tokens[i + 1]),
                          let rot = Double(tokens[i + 2]),
                          let largeArc = Double(tokens[i + 3]),
                          let sweep = Double(tokens[i + 4]),
                          let rawX = Double(tokens[i + 5]),
                          let rawY = Double(tokens[i + 6])
                    {
                        let end: CGPoint
                        if isRelative {
                            end = CGPoint(x: currentPoint.x + rawX, y: currentPoint.y + rawY)
                        } else {
                            end = CGPoint(x: rawX, y: rawY)
                        }
                        let segments = arcToCubicBeziers(
                            x1: Double(currentPoint.x), y1: Double(currentPoint.y),
                            x2: Double(end.x), y2: Double(end.y),
                            rx: rx, ry: ry,
                            xAxisRotationDeg: rot,
                            largeArcFlag: largeArc != 0,
                            sweepFlag: sweep != 0
                        )
                        for seg in segments {
                            path.addCurve(
                                to: CGPoint(x: seg.x, y: seg.y),
                                control1: CGPoint(x: seg.cp1x, y: seg.cp1y),
                                control2: CGPoint(x: seg.cp2x, y: seg.cp2y)
                            )
                        }
                        currentPoint = end
                        lastControlPoint = nil
                        i += 7
                        // Implicit-repeat: subsequent arcs share the same A/a command letter,
                        // so keep consuming 7-tuples until a non-numeric token appears.
                        if i >= tokens.count || tokens[i].first?.isLetter == true { break }
                    }
                case "Z", "z":
                    path.closeSubpath()
                    lastControlPoint = nil
                default:
                    break
                }
            } else {
                // Implicit repeat of last command
                switch lastCommand {
                case "M", "L":
                    if i + 1 < tokens.count, let x = Double(tokens[i]), let y = Double(tokens[i + 1]) {
                        if lastCommand == "M" {
                            // After first M, implicit coords are L
                            path.addLine(to: CGPoint(x: x, y: y))
                        } else {
                            path.addLine(to: CGPoint(x: x, y: y))
                        }
                        currentPoint = CGPoint(x: x, y: y)
                        i += 2
                    } else { i += 1 }
                case "m", "l":
                    if i + 1 < tokens.count, let dx = Double(tokens[i]), let dy = Double(tokens[i + 1]) {
                        let pt = CGPoint(x: currentPoint.x + dx, y: currentPoint.y + dy)
                        path.addLine(to: pt)
                        currentPoint = pt
                        i += 2
                    } else { i += 1 }
                case "C":
                    if i + 5 < tokens.count,
                       let x1 = Double(tokens[i]), let y1 = Double(tokens[i + 1]),
                       let x2 = Double(tokens[i + 2]), let y2 = Double(tokens[i + 3]),
                       let x = Double(tokens[i + 4]), let y = Double(tokens[i + 5])
                    {
                        let cp1 = CGPoint(x: x1, y: y1)
                        let cp2 = CGPoint(x: x2, y: y2)
                        let end = CGPoint(x: x, y: y)
                        path.addCurve(to: end, control1: cp1, control2: cp2)
                        lastControlPoint = cp2
                        currentPoint = end
                        i += 6
                    } else { i += 1 }
                case "c":
                    if i + 5 < tokens.count,
                       let dx1 = Double(tokens[i]), let dy1 = Double(tokens[i + 1]),
                       let dx2 = Double(tokens[i + 2]), let dy2 = Double(tokens[i + 3]),
                       let dx = Double(tokens[i + 4]), let dy = Double(tokens[i + 5])
                    {
                        let cp1 = CGPoint(x: currentPoint.x + dx1, y: currentPoint.y + dy1)
                        let cp2 = CGPoint(x: currentPoint.x + dx2, y: currentPoint.y + dy2)
                        let end = CGPoint(x: currentPoint.x + dx, y: currentPoint.y + dy)
                        path.addCurve(to: end, control1: cp1, control2: cp2)
                        lastControlPoint = cp2
                        currentPoint = end
                        i += 6
                    } else { i += 1 }
                default:
                    i += 1
                }
            }
        }

        return path
    }

    fileprivate static func reflectControlPoint(_ lastCP: CGPoint?, current: CGPoint) -> CGPoint {
        guard let cp = lastCP else { return current }
        return CGPoint(x: 2 * current.x - cp.x, y: 2 * current.y - cp.y)
    }

    /// Tokenize an SVG path `d` attribute into commands and numbers.
    ///
    /// SVG path numbers can be packed without separators in several ways:
    ///   - a `-` mid-token starts a new negative number (`12-5` → `12`, `-5`)
    ///   - a second `.` mid-token starts a new decimal (`.621.504` → `.621`, `.504`)
    ///   - `e`/`E` exponents are preserved (`1.2e-3` is one number)
    /// Heroicons uses the second form heavily, so splitting on it is required
    /// for paths like the home icon to parse at all.
    fileprivate static func tokenizeSVGPath(_ d: String) -> [String] {
        var tokens: [String] = []
        var current = ""

        for char in d {
            if char.isLetter {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                }
                tokens.append(String(char))
            } else if char == "," || char == " " || char == "\t" || char == "\n" || char == "\r" {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                }
            } else if char == "-" && !current.isEmpty && current.last != "e" && current.last != "E" {
                tokens.append(current)
                current = String(char)
            } else if char == "." && current.contains(".") {
                // Second decimal point — flush and start a new number with the dot.
                tokens.append(current)
                current = "."
            } else {
                current.append(char)
            }
        }

        if !current.isEmpty {
            tokens.append(current)
        }

        return tokens
    }
}

/// One cubic bezier segment produced by converting an SVG elliptical arc.
fileprivate struct CubicSegment {
    let cp1x: Double
    let cp1y: Double
    let cp2x: Double
    let cp2y: Double
    let x: Double
    let y: Double
}

/// Convert an SVG elliptical arc segment into a list of cubic bezier curves
/// approximating the arc. Implementation follows W3C SVG 1.1 Appendix F.6
/// ("Elliptical arc implementation notes"). The arc is split into sub-arcs
/// no larger than π/2 and each sub-arc is approximated by one cubic bezier.
fileprivate func arcToCubicBeziers(
    x1: Double, y1: Double,
    x2: Double, y2: Double,
    rx rxIn: Double, ry ryIn: Double,
    xAxisRotationDeg: Double,
    largeArcFlag: Bool,
    sweepFlag: Bool
) -> [CubicSegment] {
    // Degenerate radii → straight line.
    if rxIn == 0 || ryIn == 0 {
        return [CubicSegment(cp1x: x2, cp1y: y2, cp2x: x2, cp2y: y2, x: x2, y: y2)]
    }
    let phi = xAxisRotationDeg * .pi / 180.0
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)

    // Step 1: compute (x1', y1') — endpoints in rotated/centered frame.
    let dx = (x1 - x2) / 2.0
    let dy = (y1 - y2) / 2.0
    let x1p = cosPhi * dx + sinPhi * dy
    let y1p = -sinPhi * dx + cosPhi * dy

    // Correct out-of-range radii.
    var rx = abs(rxIn)
    var ry = abs(ryIn)
    let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
        let s = sqrt(lambda)
        rx *= s
        ry *= s
    }

    // Step 2: compute center (cx', cy') then (cx, cy).
    let sign: Double = (largeArcFlag == sweepFlag) ? -1.0 : 1.0
    let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    let sq = max(0.0, num / den)
    let coef = sign * sqrt(sq)
    let cxp = (coef * rx * y1p) / ry
    let cyp = (-coef * ry * x1p) / rx
    let cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2.0
    let cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2.0

    // Step 3: compute theta1 and deltaTheta.
    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
        let dot = ux * vx + uy * vy
        let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
        var a = acos(min(1.0, max(-1.0, dot / len)))
        if (ux * vy - uy * vx) < 0 { a = -a }
        return a
    }
    let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    var deltaTheta = angle(
        (x1p - cxp) / rx, (y1p - cyp) / ry,
        (-x1p - cxp) / rx, (-y1p - cyp) / ry
    )
    if !sweepFlag && deltaTheta > 0 { deltaTheta -= 2 * .pi }
    else if sweepFlag && deltaTheta < 0 { deltaTheta += 2 * .pi }

    // Step 4: split into sub-arcs ≤ π/2 and build bezier control points.
    let numSegs = max(1, Int(ceil(abs(deltaTheta) / (.pi / 2.0))))
    let delta = deltaTheta / Double(numSegs)
    let t = (8.0 / 3.0) * sin(delta / 4.0) * sin(delta / 4.0) / sin(delta / 2.0)

    var result: [CubicSegment] = []
    result.reserveCapacity(numSegs)
    var theta = theta1
    var startX = x1
    var startY = y1
    for _ in 0..<numSegs {
        let theta2 = theta + delta
        let cosT1 = cos(theta)
        let sinT1 = sin(theta)
        let cosT2 = cos(theta2)
        let sinT2 = sin(theta2)
        let endX = cosPhi * rx * cosT2 - sinPhi * ry * sinT2 + cx
        let endY = sinPhi * rx * cosT2 + cosPhi * ry * sinT2 + cy
        let cp1x = startX + t * (-cosPhi * rx * sinT1 - sinPhi * ry * cosT1)
        let cp1y = startY + t * (-sinPhi * rx * sinT1 + cosPhi * ry * cosT1)
        let cp2x = endX + t * (cosPhi * rx * sinT2 + sinPhi * ry * cosT2)
        let cp2y = endY + t * (sinPhi * rx * sinT2 - cosPhi * ry * cosT2)
        result.append(CubicSegment(
            cp1x: cp1x, cp1y: cp1y,
            cp2x: cp2x, cp2y: cp2y,
            x: endX, y: endY
        ))
        theta = theta2
        startX = endX
        startY = endY
    }
    return result
}

/// Sendable value-type representation of a single SVG path from `__iconPaths`.
/// Used to cross the Canvas draw closure boundary without capturing `[String: Any]`.
private struct IconPathData: Sendable {
    let d: String
    let fill: String
    let stroke: String
    let strokeWidth: CGFloat
    let lineCap: String
    let lineJoin: String

    init(dict: [String: Any]) {
        self.d = (dict["d"] as? String) ?? ""
        self.fill = (dict["fill"] as? String) ?? "none"
        self.stroke = (dict["stroke"] as? String) ?? "currentColor"
        let sw = (dict["strokeWidth"] as? Double)
            ?? (dict["strokeWidth"] as? NSNumber)?.doubleValue
            ?? 2.0
        self.strokeWidth = CGFloat(sw)
        self.lineCap = (dict["strokeLinecap"] as? String) ?? "round"
        self.lineJoin = (dict["strokeLinejoin"] as? String) ?? "round"
    }
}

/// Canvas-based icon renderer that honors per-path `fill`, `stroke`, and
/// `strokeWidth`. Lucide-style icons are stroke-only (`fill: "none"`,
/// `stroke: "currentColor"`), which filling-only renderers turn into
/// degenerate blobs — so we must draw each path with its own style.
private struct IconCanvasView: View {
    let paths: [IconPathData]
    let viewBox: CGRect
    let tint: Color

    var body: some View {
        Canvas { context, canvasSize in
            let scaleX = canvasSize.width / viewBox.width
            let scaleY = canvasSize.height / viewBox.height
            // Use uniform scale for stroke width so it doesn't distort on non-square viewBoxes.
            let strokeScale = min(scaleX, scaleY)

            for pathData in paths {
                guard !pathData.d.isEmpty,
                      let cgPath = Self.parseSVGPath(pathData.d) else { continue }

                var transform = CGAffineTransform(scaleX: scaleX, y: scaleY)
                    .translatedBy(x: -viewBox.origin.x, y: -viewBox.origin.y)
                guard let scaled = cgPath.copy(using: &transform) else { continue }
                let path = Path(scaled)

                if pathData.fill != "none" {
                    let fillColor = pathData.fill == "currentColor"
                        ? tint
                        : (ColorParser.parse(pathData.fill) ?? tint)
                    context.fill(path, with: .color(fillColor))
                }

                if pathData.stroke != "none" {
                    let strokeColor = pathData.stroke == "currentColor"
                        ? tint
                        : (ColorParser.parse(pathData.stroke) ?? tint)
                    var style = StrokeStyle(lineWidth: pathData.strokeWidth * strokeScale)
                    style.lineCap = pathData.lineCap == "round"
                        ? .round
                        : (pathData.lineCap == "square" ? .square : .butt)
                    style.lineJoin = pathData.lineJoin == "round"
                        ? .round
                        : (pathData.lineJoin == "bevel" ? .bevel : .miter)
                    context.stroke(path, with: .color(strokeColor), style: style)
                }
            }
        }
    }

    /// Delegate to `IconShape.parseSVGPath` by instantiating a throwaway shape.
    /// Kept as a static helper so the Canvas closure stays Sendable-clean.
    private static func parseSVGPath(_ d: String) -> CGPath? {
        IconShape.parseSVGPathStatic(d)
    }
}

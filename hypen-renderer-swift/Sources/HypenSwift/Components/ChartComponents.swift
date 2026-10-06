import SwiftUI

// ============================================================================
// Chart family — SwiftUI shell
// ============================================================================
//
// `Chart` owns a coordinate space. Its children are marks (`Line`, `Area`,
// `Bars`, `Points`, `Axis`, `Rule`, `Marker`, `Path`) whose props are written
// in DATA units, never pixels. The chart resolves the x/y domains, lays every
// mark out, draws them all in ONE SwiftUI `Canvas`, and overlays `Marker`
// children as ordinary Hypen views anchored to their data point.
//
// All the arithmetic lives in `ChartGeometry.swift` (no SwiftUI, unit-tested
// in `Tests/HypenSwiftTests/ChartGeometryTests.swift`); this file only reads
// props, resolves colours, paints and wires gestures.
//
// Contract: `hypen-docs/content/docs/guide/charts.mdx`.
// Reference implementation: `hypen-web/packages/web/src/dom/components/chart.ts`.

// MARK: - Style

/// A mark's paint, resolved from its applicator props.
///
/// `nil` stroke/fill with the matching `none` flag clear means "use the
/// inherited text colour", which the canvas paints with
/// `GraphicsContext.Shading.foreground` so `.color()` on the Chart *or any
/// ancestor* flows in exactly as it does for `Text`.
struct ChartMarkStyle: Sendable {
    var stroke: Color?
    var fill: Color?
    var strokeNone: Bool = false
    var fillNone: Bool = false
    /// `.color()` on the mark itself: the default for both stroke and fill.
    var tint: Color?
    var strokeWidth: CGFloat = 1
    var dash: [CGFloat] = []
    var lineCap: ChartLineCap = .round
    var opacity: Double = 1
    var fillOpacity: Double = 1
    var strokeOpacity: Double = 1
    var blend: ChartBlend = .normal
    var shadow: ChartShapeShadow?

    /// Presentation defaults per mark, ported from `MARK_DEFAULT_ATTRS`.
    static func defaults(for kind: ChartMarkKind) -> ChartMarkStyle {
        var style = ChartMarkStyle()
        switch kind {
        case .line:
            style.fillNone = true
            style.strokeWidth = ChartDefaults.lineStrokeWidth
        case .area:
            style.strokeNone = true
            style.fillOpacity = ChartDefaults.areaFillOpacity
        case .bars, .points:
            style.strokeNone = true
        case .axis:
            style.strokeWidth = ChartDefaults.axisStrokeWidth
            style.strokeOpacity = ChartDefaults.axisStrokeOpacity
            style.fillOpacity = ChartDefaults.axisTextOpacity
        case .rule:
            style.fillNone = true
            style.strokeWidth = ChartDefaults.ruleStrokeWidth
            style.dash = ChartDefaults.ruleDash
            style.strokeOpacity = ChartDefaults.ruleStrokeOpacity
        case .path:
            style.fillNone = true
            style.strokeWidth = ChartDefaults.pathStrokeWidth
        case .marker:
            break
        }
        return style
    }

    var strokeShading: GraphicsContext.Shading? {
        if strokeNone { return nil }
        if let stroke = stroke { return .color(stroke) }
        if let tint = tint { return .color(tint) }
        return .foreground
    }

    var fillShading: GraphicsContext.Shading? {
        if fillNone { return nil }
        if let fill = fill { return .color(fill) }
        if let tint = tint { return .color(tint) }
        return .foreground
    }

    /// The colour axis labels are drawn in. Nil keeps the inherited one.
    var textColor: Color? { fill ?? tint }
}

enum ChartLineCap: String, Sendable {
    case butt
    case round
    case square

    var cgValue: CGLineCap {
        switch self {
        case .butt: return .butt
        case .round: return .round
        case .square: return .square
        }
    }
}

/// `mixBlendMode`, in the CSS spellings the DSL uses.
enum ChartBlend: String, CaseIterable, Sendable {
    case normal
    case multiply
    case screen
    case overlay
    case darken
    case lighten
    case colorDodge
    case colorBurn
    case softLight
    case hardLight
    case difference
    case exclusion
    case hue
    case saturation
    case color
    case luminosity
    case plusLighter
    case plusDarker

    static func named(_ raw: String?) -> ChartBlend {
        guard let raw = raw else { return .normal }
        let key = raw.replacingOccurrences(of: "-", with: "").lowercased()
        return ChartBlend.allCases.first { $0.rawValue.lowercased() == key } ?? .normal
    }

    var graphicsValue: GraphicsContext.BlendMode {
        switch self {
        case .normal: return .normal
        case .multiply: return .multiply
        case .screen: return .screen
        case .overlay: return .overlay
        case .darken: return .darken
        case .lighten: return .lighten
        case .colorDodge: return .colorDodge
        case .colorBurn: return .colorBurn
        case .softLight: return .softLight
        case .hardLight: return .hardLight
        case .difference: return .difference
        case .exclusion: return .exclusion
        case .hue: return .hue
        case .saturation: return .saturation
        case .color: return .color
        case .luminosity: return .luminosity
        case .plusLighter: return .plusLighter
        case .plusDarker: return .plusDarker
        }
    }
}

/// A shape shadow: what `glow`, `shadow`, `boxShadow`, `dropShadow` and
/// `elevation` all mean on a mark. A *box* shadow would be invisible on
/// geometry, so every one of them becomes a shadow of the painted shape.
struct ChartShapeShadow: Sendable {
    var color: Color
    var radius: CGFloat
    var dx: CGFloat = 0
    var dy: CGFloat = 0
}

/// The event applicators a mark understands, with their static arguments.
struct ChartMarkEvents: Sendable {
    var click: ActionValue?
    var longPress: ActionValue?
    var hover: ActionValue?
    var move: ActionValue?
    var leave: ActionValue?

    /// A mark WITHOUT any event applicator must be pointer-transparent, so a
    /// tooltip's Points/Marker never steals the pointer from the Line being
    /// hovered.
    var isInteractive: Bool {
        click != nil || longPress != nil || hover != nil || move != nil || leave != nil
    }
}

// MARK: - Specs

/// One mark, fully resolved from its element's props.
struct ChartMarkSpec: Sendable {
    var id: String
    var kind: ChartMarkKind
    var series: String
    var data: [ChartDatum]
    var style: ChartMarkStyle
    var events: ChartMarkEvents

    // Line / Area
    var smooth: Bool = false
    // Axis
    var axis: ChartAxisKind = .x
    var tickCount: Int = ChartDefaults.ticks
    var axisLabel: String?
    var grid: Bool = false
    // Rule / Marker
    var refX: ChartX?
    var refY: Double?
    var anchor: ChartMarkerAnchor = .top
    // Bars
    var barRatio: Double = ChartDefaults.barWidth
    var cornerRadius: CGFloat = 0
    // Bars / Points
    var highlight: Set<Int>?
    var pointRadius: CGFloat = ChartDefaults.pointRadius
    // Path
    var pathData: String?

    var layoutInput: ChartMarkInput {
        ChartMarkInput(
            kind: kind,
            data: data,
            axis: kind == .axis ? axis : nil,
            refX: refX,
            refY: refY
        )
    }

    /// Whether row `index` is dimmed by a `highlight:` selection.
    func isDimmed(_ index: Int) -> Bool {
        guard let highlight = highlight else { return false }
        return !highlight.contains(index)
    }
}

/// The whole chart, resolved once per body evaluation.
struct ChartSpec: Sendable {
    var padding: Double?
    var explicitX: (Double, Double)?
    var explicitY: (Double, Double)?
    var marks: [ChartMarkSpec] = []
    var events: ChartMarkEvents = ChartMarkEvents()
}

// MARK: - Prop reading

/// Prop plumbing shared by the chart and its marks.
///
/// Props arrive under three spellings — a named argument (`points`), the
/// engine's positional form (`"0"`), and an applicator's first value
/// (`stroke.0`) — so every lookup tries all of them, case-insensitively.
enum ChartProps {

    /// Lowercase every prop key once, so lookups can use canonical names.
    static func lowercased(_ props: [String: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        out.reserveCapacity(props.count)
        for (key, value) in props {
            out[key.lowercased()] = value
        }
        return out
    }

    /// A raw value under `name` or `name.0` (keys already lowercased).
    static func value(_ props: [String: Any], _ name: String) -> Any? {
        if let value = props["\(name).0"], !(value is NSNull) { return value }
        if let value = props[name], !(value is NSNull) { return value }
        return nil
    }

    static func string(_ props: [String: Any], _ name: String) -> String? {
        guard let value = value(props, name) else { return nil }
        if let string = value as? String { return string }
        return String(describing: value)
    }

    static func number(_ props: [String: Any], _ name: String) -> Double? {
        ChartJSON.from(value(props, name)).numberValue
    }

    static func length(_ props: [String: Any], _ name: String) -> CGFloat? {
        // `parseCGFloat` (SizeApplicators.swift) also accepts unit-bearing
        // strings such as `"3px"`, which is how a Tailwind-ish authoring
        // style spells a stroke width.
        if let parsed = parseCGFloat(value(props, name)) { return parsed }
        return number(props, name).map { CGFloat($0) }
    }

    /// One event applicator, with its static arguments.
    ///
    /// `.onClick(@actions.pick, tag: "targets")` lowers to
    /// `onClick.0 = "@actions.pick"` and `onClick.tag = "targets"`; both make
    /// up the action's payload before the datum is merged on top.
    static func action(_ props: [String: Any], _ names: [String]) -> ActionValue? {
        for name in names {
            let prefix = "\(name)."
            var group: [String: Any] = [:]
            for (key, value) in props {
                if key == name {
                    group["0"] = value
                } else if key.hasPrefix(prefix) {
                    group[String(key.dropFirst(prefix.count))] = value
                }
            }
            if group.isEmpty { continue }
            if group.count == 1, let only = group["0"] {
                if let action = ActionValue.from(only) { return action }
            }
            if let action = ActionValue.from(group) { return action }
        }
        return nil
    }

    /// Every event applicator a mark (or the Chart itself) understands.
    static func events(_ props: [String: Any]) -> ChartMarkEvents {
        ChartMarkEvents(
            click: action(props, ["onclick", "onpress", "ontap"]),
            longPress: action(props, ["onlongpress", "onlongclick"]),
            hover: action(props, ["onhover", "onmouseenter", "onpointerenter"]),
            move: action(props, ["onmove", "onpointermove", "onmousemove"]),
            leave: action(props, ["onmouseleave", "onpointerleave", "onleave"])
        )
    }

    /// A dash pattern from `"4 4"`, `"4,4"` or `[4, 4]`.
    static func dash(_ props: [String: Any], _ name: String) -> [CGFloat]? {
        guard let raw = value(props, name) else { return nil }
        if let list = raw as? [Any] {
            let values = list.compactMap { ChartJSON.from($0).numberValue }
            return values.isEmpty ? nil : values.map { CGFloat($0) }
        }
        guard let text = raw as? String else { return nil }
        let parts = text
            .replacingOccurrences(of: ",", with: " ")
            .split(separator: " ")
            .compactMap { Double($0) }
        return parts.isEmpty ? nil : parts.map { CGFloat($0) }
    }

    /// Named applicators arrive as separate keys (glow.color, glow.radius).
    static func effectValue(_ props: [String: Any], _ name: String) -> Any? {
        if let raw = value(props, name) { return raw }
        let prefix = name + "."
        let fields = props.reduce(into: [String: Any]()) { result, pair in
            if pair.key.hasPrefix(prefix) {
                result[String(pair.key.dropFirst(prefix.count))] = pair.value
            }
        }
        return fields.isEmpty ? nil : fields
    }

    /// `glow(color | radius | {color, radius})` — a soft zero-offset shadow
    /// of the painted shape, 6pt in the text colour by default.
    static func glow(_ props: [String: Any], tint: Color) -> ChartShapeShadow? {
        guard let raw = effectValue(props, "glow") else { return nil }
        if let flag = raw as? Bool, !flag { return nil }
        var color = tint
        var radius = ChartDefaults.glowRadius
        if let number = ChartJSON.from(raw).numberValue {
            radius = CGFloat(number)
        } else if let text = raw as? String {
            color = ColorParser.parse(text) ?? tint
        } else if let dict = raw as? [String: Any] {
            if let parsed = ColorParser.parse(dict["color"]) { color = parsed }
            if let value = ChartJSON.from(dict["radius"] ?? dict["blur"]).numberValue {
                radius = CGFloat(value)
            }
        }
        return ChartShapeShadow(color: color, radius: radius)
    }

    /// `shadow` / `boxShadow` / `dropShadow` / `elevation` — all shape
    /// shadows on a mark, because a box shadow would be invisible on
    /// geometry.
    static func shadow(_ props: [String: Any]) -> ChartShapeShadow? {
        if let elevation = number(props, "elevation") {
            guard elevation > 0 else { return nil }
            return ChartShapeShadow(
                color: Color.black.opacity(0.33),
                radius: CGFloat(elevation) * 1.5,
                dy: 2
            )
        }
        for name in ["shadow", "boxshadow", "dropshadow"] {
            guard let raw = effectValue(props, name) else { continue }
            if let dict = raw as? [String: Any] {
                let color = ColorParser.parse(dict["color"]) ?? Color.black.opacity(0.33)
                let blur = ChartJSON.from(dict["blur"] ?? dict["radius"]).numberValue ?? 4
                let dx = ChartJSON.from(dict["x"]).numberValue ?? 0
                let dy = ChartJSON.from(dict["y"]).numberValue ?? 0
                return ChartShapeShadow(
                    color: color, radius: CGFloat(blur), dx: CGFloat(dx), dy: CGFloat(dy)
                )
            }
            if let text = raw as? String {
                return parseCssShadow(text)
            }
        }
        return nil
    }

    /// A permissive `0 2px 8px #000` reader: up to three leading lengths,
    /// then whatever colour token is left.
    static func parseCssShadow(_ text: String) -> ChartShapeShadow? {
        let tokens = text.split(separator: " ").map(String.init)
        guard !tokens.isEmpty else { return nil }
        var lengths: [CGFloat] = []
        var colorToken: String?
        for token in tokens {
            if let length = parseCGFloat(token), lengths.count < 3 {
                lengths.append(length)
            } else {
                colorToken = colorToken.map { "\($0) \(token)" } ?? token
            }
        }
        let color = colorToken.flatMap { ColorParser.parse($0) } ?? Color.black.opacity(0.33)
        return ChartShapeShadow(
            color: color,
            radius: lengths.count > 2 ? lengths[2] : 4,
            dx: lengths.count > 0 ? lengths[0] : 0,
            dy: lengths.count > 1 ? lengths[1] : 0
        )
    }

    /// A mark's paint. `stroke: "none"` / `fill: "none"` clear the channel,
    /// exactly as they do on SVG geometry.
    static func style(kind: ChartMarkKind, props: [String: Any], tint: Color) -> ChartMarkStyle {
        var style = ChartMarkStyle.defaults(for: kind)

        // Colours go to `ColorParser` raw: it also understands the map and
        // list spellings a colour prop can arrive in.
        if let raw = value(props, "color"), let color = ColorParser.parse(raw) {
            style.tint = color
        }
        if let raw = value(props, "stroke") {
            if (raw as? String)?.lowercased() == "none" {
                style.strokeNone = true
            } else if let color = ColorParser.parse(raw) {
                style.stroke = color
                style.strokeNone = false
            }
        }
        if let raw = value(props, "fill") {
            if (raw as? String)?.lowercased() == "none" {
                style.fillNone = true
            } else if let color = ColorParser.parse(raw) {
                style.fill = color
                style.fillNone = false
            }
        }
        if let width = length(props, "strokewidth") { style.strokeWidth = width }
        if let dash = dash(props, "strokedasharray") { style.dash = dash }
        if let cap = string(props, "strokelinecap"), let parsed = ChartLineCap(rawValue: cap.lowercased()) {
            style.lineCap = parsed
        }
        if let opacity = number(props, "opacity") { style.opacity = opacity }
        if let opacity = number(props, "fillopacity") { style.fillOpacity = opacity }
        if let opacity = number(props, "strokeopacity") { style.strokeOpacity = opacity }
        style.blend = ChartBlend.named(string(props, "mixblendmode"))
        style.shadow = glow(props, tint: style.tint ?? tint) ?? shadow(props)
        return style
    }
}

// MARK: - Spec building

extension ChartSpec {

    /// Read the Chart's own props and every mark child.
    @MainActor
    static func build(element: HypenElement, renderer: HypenRenderer, tint: Color) -> ChartSpec {
        let props = ChartProps.lowercased(element.props)
        let json = ChartJSON.props(props)

        var spec = ChartSpec(
            // The NAMED-ARGUMENT spelling only. `.padding(12)` is the ordinary
            // layout applicator and already went to `hypenModifier`; reading it
            // here too would inset the plot AND pad the host.
            padding: ChartJSON.from(props["padding"]).numberValue,
            explicitX: ChartData.readRange(ChartData.prop(json, "x")),
            explicitY: ChartData.readRange(ChartData.prop(json, "y"))
        )
        spec.events = ChartProps.events(props)

        for childId in element.children {
            guard let child = renderer.getElement(childId),
                  let kind = ChartMarkKind.named(child.elementType)
            else { continue }
            spec.marks.append(
                ChartMarkSpec.build(element: child, kind: kind, tint: tint)
            )
        }
        return spec
    }
}

extension ChartMarkSpec {

    @MainActor
    static func build(
        element: HypenElement, kind: ChartMarkKind, tint: Color
    ) -> ChartMarkSpec {
        let props = ChartProps.lowercased(element.props)
        let json = ChartJSON.props(props)

        // `series:` / `name:` label the mark in the payload; its kind is the
        // fallback, so an unnamed Bars still reports `series: "bars"`.
        var series = kind.rawValue
        if let declared = ChartProps.string(props, "series") ?? ChartProps.string(props, "name"),
           !declared.isEmpty {
            series = declared
        }

        var spec = ChartMarkSpec(
            id: element.id,
            kind: kind,
            series: series,
            data: kind.isDataMark ? ChartData.normalize(json) : [],
            style: ChartProps.style(kind: kind, props: props, tint: tint),
            events: ChartProps.events(props)
        )

        switch kind {
        case .line, .area:
            spec.smooth = ChartData.flag(ChartData.prop(json, "smooth"))

        case .bars:
            spec.barRatio = ChartProps.number(props, "barwidth") ?? ChartDefaults.barWidth
            spec.cornerRadius = ChartProps.length(props, "radius") ?? 0
            spec.highlight = ChartData.highlightSet(ChartData.prop(json, "highlight"))

        case .points:
            spec.pointRadius = ChartProps.length(props, "radius") ?? ChartDefaults.pointRadius
            spec.highlight = ChartData.highlightSet(ChartData.prop(json, "highlight"))

        case .axis:
            spec.axis = ChartData.axisKind(json)
            spec.tickCount = ChartProps.number(props, "ticks").map { Int($0) } ?? ChartDefaults.ticks
            spec.axisLabel = ChartProps.string(props, "label")
            spec.grid = ChartData.flag(ChartData.prop(json, "grid"))

        case .rule, .marker:
            spec.refY = ChartData.prop(json, "y")?.numberValue
            spec.refX = ChartData.prop(json, "x").flatMap { ChartX.from($0) }
            if kind == .marker {
                spec.anchor = ChartMarkerAnchor.named(ChartProps.string(props, "anchor"))
            }

        case .path:
            spec.pathData = ChartProps.string(props, "d") ?? ChartProps.string(props, "0")
        }
        return spec
    }

    /// A Marker is pointer-transparent unless something inside it wants
    /// events — a tooltip must not steal the pointer from the Line it
    /// describes, but a tappable badge inside one must still work.
    @MainActor
    static func subtreeHasEvents(_ id: String, renderer: HypenRenderer, depth: Int = 0) -> Bool {
        guard depth < 16, let element = renderer.getElement(id) else { return false }
        if element.props.keys.contains(where: { $0.lowercased().hasPrefix("on") }) {
            return true
        }
        for childId in element.children {
            if subtreeHasEvents(childId, renderer: renderer, depth: depth + 1) { return true }
        }
        return false
    }
}

// MARK: - Components

/// `Chart` — the coordinate space. Registered under `"chart"`.
public struct ChartComponent: ComponentHandler {
    public let typeName = "chart"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let element = context.element
        // The glow default and a mark's own `.color()` need a concrete
        // colour; everything else paints with `.foreground` so an ancestor's
        // `.color()` still flows in.
        let tint = modifier.foregroundColor ?? Color.primary
        let spec = ChartSpec.build(element: element, renderer: context.renderer, tint: tint)

        // `.width()` / `.height()` applicators already sit on the modifier
        // and are applied by `hypenModifier`; only fill in what neither the
        // applicator nor a `Chart(width:)` argument supplied. Default height
        // is 200 and the width fills the parent, matching the web.
        let fallbackWidth: CGFloat? = modifier.width == nil
            ? parseCGFloat(element.props["width"])
            : nil
        let fallbackHeight: CGFloat? = modifier.height == nil
            ? (parseCGFloat(element.props["height"]) ?? ChartDefaults.height)
            : nil
        let fillsWidth = modifier.width == nil && fallbackWidth == nil

        return AnyView(
            ChartHostView(
                spec: spec,
                renderer: context.renderer,
                dispatcher: context.actionDispatcher
            )
            .frame(width: fallbackWidth, height: fallbackHeight)
            .modifier(ChartFillWidth(active: fillsWidth))
            .hypenModifier(modifier)
        )
    }
}

/// The chart fills its parent's width unless something pinned it, matching
/// the web host's `width: 100%`.
private struct ChartFillWidth: ViewModifier {
    let active: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if active {
            content.frame(maxWidth: .infinity)
        } else {
            content
        }
    }
}

/// The mark types. A mark is drawn by its enclosing `Chart`, so on its own
/// it renders nothing — which also keeps a stray mark out of the container
/// fallback in `HypenElementView`.
public struct ChartMarkComponent: ComponentHandler {
    public let typeName: String

    public init(typeName: String) {
        self.typeName = typeName
    }

    /// One handler per mark kind, for `ComponentRegistry.withDefaults()`.
    public static func all() -> [ChartMarkComponent] {
        ChartMarkKind.allCases.map { ChartMarkComponent(typeName: $0.rawValue) }
    }

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        AnyView(EmptyView())
    }
}

// MARK: - Host view

/// Lays the chart out against its real size and stacks the three planes:
/// the chart's own event surface, the marks' `Canvas`, the marks' hit
/// surfaces, and the Markers.
@MainActor
struct ChartHostView: View {
    let spec: ChartSpec
    let renderer: HypenRenderer
    let dispatcher: ActionDispatcher

    var body: some View {
        GeometryReader { geometry in
            let layout = ChartLayout.resolve(
                size: geometry.size,
                padding: spec.padding,
                explicitX: spec.explicitX,
                explicitY: spec.explicitY,
                marks: spec.marks.map { $0.layoutInput }
            )
            ZStack(alignment: .topLeading) {
                if spec.events.isInteractive {
                    ChartSurfaceGestures(
                        events: spec.events,
                        dispatcher: dispatcher,
                        payload: { point in ChartHitTest.chartPayload(layout: layout, point: point).dictionary }
                    )
                }

                ChartCanvasView(marks: spec.marks, layout: layout)
                    .allowsHitTesting(false)

                ForEach(spec.marks, id: \.id) { mark in
                    if mark.kind != .marker && mark.events.isInteractive {
                        ChartMarkHitView(mark: mark, layout: layout, dispatcher: dispatcher)
                    }
                }

                ForEach(spec.marks, id: \.id) { mark in
                    if mark.kind == .marker, let element = renderer.getElement(mark.id) {
                        ChartMarkerView(
                            mark: mark,
                            element: element,
                            layout: layout,
                            renderer: renderer,
                            dispatcher: dispatcher
                        )
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
    }
}

// MARK: - Path building

/// `Path` construction shared by the canvas and the hit surfaces.
///
/// Deliberately NOT a `View`: conforming to `View` would infer `@MainActor`
/// onto the whole type, and `ChartMarkSpec.hitPath` needs these from a
/// nonisolated context.
enum ChartPathBuilder {

    /// The polyline through a mark's data, smoothed with Catmull-Rom→cubic
    /// when `smooth: true`.
    static func line(_ points: [CGPoint], smooth: Bool) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        if smooth, points.count >= 3 {
            for segment in ChartGeometry.smoothSegments(points) {
                path.addCurve(
                    to: segment.end, control1: segment.control1, control2: segment.control2
                )
            }
        } else {
            for point in points.dropFirst() {
                path.addLine(to: point)
            }
        }
        return path
    }

    /// The line closed back down to the zero line — the Area's region.
    static func area(_ points: [CGPoint], base: CGFloat, smooth: Bool) -> Path {
        var path = line(points, smooth: smooth)
        guard let first = points.first, let last = points.last else { return path }
        path.addLine(to: CGPoint(x: last.x, y: base))
        path.addLine(to: CGPoint(x: first.x, y: base))
        path.closeSubpath()
        return path
    }

    /// A `Path(d:)` mark's data-unit coordinates put through one affine
    /// transform. Stroking AFTER the transform is what keeps the stroke
    /// width uniform (SVG's `vector-effect: non-scaling-stroke`).
    static func transformed(_ d: String?, layout: ChartLayout) -> Path? {
        guard let d = d,
              !d.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let parsed = HypenSVGPath.parse(d)
        else { return nil }
        var transform = ChartGeometry.pathTransform(layout: layout)
        guard let transformed = parsed.copy(using: &transform) else { return nil }
        return Path(transformed)
    }
}

// MARK: - Canvas

/// Every mark, painted in one pass. The draw closure captures only Sendable
/// values (`ChartMarkSpec` / `ChartLayout`), which is why the spec resolves
/// props eagerly instead of carrying `[String: Any]` in here.
struct ChartCanvasView: View {
    let marks: [ChartMarkSpec]
    let layout: ChartLayout

    var body: some View {
        Canvas { context, _ in
            for mark in marks {
                ChartCanvasView.draw(mark, layout: layout, into: &context)
            }
        }
    }

    // MARK: Painting helpers

    /// Run `body` with a temporary opacity, restoring the previous one.
    /// Cheaper and more predictable than nesting a layer per paint call.
    private static func withOpacity(
        _ alpha: Double, _ context: inout GraphicsContext, _ body: (inout GraphicsContext) -> Void
    ) {
        guard alpha > 0 else { return }
        let saved = context.opacity
        context.opacity = alpha
        body(&context)
        context.opacity = saved
    }

    private static func paintFill(
        _ path: Path, style: ChartMarkStyle, opacity: Double, into context: inout GraphicsContext
    ) {
        guard let shading = style.fillShading else { return }
        withOpacity(style.opacity * opacity, &context) { ctx in
            ctx.fill(path, with: shading)
        }
    }

    private static func paintStroke(
        _ path: Path,
        style: ChartMarkStyle,
        width: CGFloat? = nil,
        dash: [CGFloat]? = nil,
        opacity: Double? = nil,
        into context: inout GraphicsContext
    ) {
        guard let shading = style.strokeShading else { return }
        let strokeStyle = StrokeStyle(
            lineWidth: width ?? style.strokeWidth,
            lineCap: style.lineCap.cgValue,
            lineJoin: .round,
            dash: dash ?? style.dash
        )
        withOpacity(style.opacity * (opacity ?? style.strokeOpacity), &context) { ctx in
            ctx.stroke(path, with: shading, style: strokeStyle)
        }
    }

    /// Draw one mark, scoping its blend mode and shape shadow to itself.
    static func draw(_ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext) {
        if let shadow = mark.style.shadow {
            context.drawLayer { layer in
                layer.addFilter(
                    .shadow(color: shadow.color, radius: shadow.radius, x: shadow.dx, y: shadow.dy)
                )
                drawBody(mark, layout: layout, into: &layer)
            }
            return
        }
        drawBody(mark, layout: layout, into: &context)
    }

    private static func drawBody(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        let savedBlend = context.blendMode
        context.blendMode = mark.style.blend.graphicsValue
        switch mark.kind {
        case .line: drawLine(mark, layout: layout, into: &context)
        case .area: drawArea(mark, layout: layout, into: &context)
        case .bars: drawBars(mark, layout: layout, into: &context)
        case .points: drawPoints(mark, layout: layout, into: &context)
        case .axis: drawAxis(mark, layout: layout, into: &context)
        case .rule: drawRule(mark, layout: layout, into: &context)
        case .path: drawPath(mark, layout: layout, into: &context)
        case .marker: break  // Markers are ordinary SwiftUI views, not paint.
        }
        context.blendMode = savedBlend
    }

    private static func positions(_ mark: ChartMarkSpec, layout: ChartLayout) -> [CGPoint] {
        ChartGeometry.project(mark.data, layout: layout).map { $0.position }
    }

    private static func drawLine(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        let points = positions(mark, layout: layout)
        guard !points.isEmpty else { return }
        paintStroke(
            ChartPathBuilder.line(points, smooth: mark.smooth), style: mark.style, into: &context
        )
    }

    private static func drawArea(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        let points = positions(mark, layout: layout)
        guard !points.isEmpty else { return }
        let path = ChartPathBuilder.area(points, base: layout.zeroY, smooth: mark.smooth)
        paintFill(path, style: mark.style, opacity: mark.style.fillOpacity, into: &context)
        paintStroke(path, style: mark.style, into: &context)
    }

    private static func drawBars(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        let projected = ChartGeometry.project(mark.data, layout: layout)
        for bar in ChartGeometry.bars(projected, layout: layout, ratio: mark.barRatio) {
            let path = mark.cornerRadius > 0
                ? Path(roundedRect: bar.rect, cornerRadius: mark.cornerRadius)
                : Path(bar.rect)
            let opacity = mark.isDimmed(bar.index)
                ? ChartDefaults.dimmedOpacity
                : mark.style.fillOpacity
            paintFill(path, style: mark.style, opacity: opacity, into: &context)
            paintStroke(path, style: mark.style, into: &context)
        }
    }

    private static func drawPoints(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        let radius = mark.pointRadius
        for point in ChartGeometry.project(mark.data, layout: layout) {
            let rect = CGRect(
                x: point.position.x - radius,
                y: point.position.y - radius,
                width: radius * 2,
                height: radius * 2
            )
            let path = Path(ellipseIn: rect)
            let opacity = mark.isDimmed(point.index)
                ? ChartDefaults.dimmedOpacity
                : mark.style.fillOpacity
            paintFill(path, style: mark.style, opacity: opacity, into: &context)
            paintStroke(path, style: mark.style, into: &context)
        }
    }

    private static func label(_ text: String, style: ChartMarkStyle) -> Text {
        let base = Text(text).font(.system(size: ChartDefaults.fontSize))
        if let color = style.textColor {
            return base.foregroundColor(color)
        }
        return base
    }

    private static func drawAxis(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        let plot = layout.plot
        let ticks = ChartGeometry.axisTicks(mark.axis, layout: layout, count: mark.tickCount)
        let font = ChartDefaults.fontSize

        switch mark.axis {
        case .x:
            let baseline = plot.maxY
            var axisLine = Path()
            axisLine.move(to: CGPoint(x: plot.minX, y: baseline))
            axisLine.addLine(to: CGPoint(x: plot.maxX, y: baseline))
            paintStroke(axisLine, style: mark.style, into: &context)

            for tick in ticks {
                var tickMark = Path()
                tickMark.move(to: CGPoint(x: tick.position, y: baseline))
                tickMark.addLine(to: CGPoint(x: tick.position, y: baseline + ChartDefaults.axisTickLength))
                paintStroke(tickMark, style: mark.style, into: &context)

                if mark.grid {
                    var grid = Path()
                    grid.move(to: CGPoint(x: tick.position, y: plot.minY))
                    grid.addLine(to: CGPoint(x: tick.position, y: baseline))
                    paintStroke(
                        grid, style: mark.style,
                        opacity: ChartDefaults.gridOpacity, into: &context
                    )
                }

                withOpacity(mark.style.opacity * mark.style.fillOpacity, &context) { ctx in
                    ctx.draw(
                        label(tick.text, style: mark.style),
                        at: CGPoint(x: tick.position, y: baseline + 6),
                        anchor: .top
                    )
                }
            }

            if let title = mark.axisLabel, !title.isEmpty {
                let y = Swift.min(layout.size.height - font, baseline + 8 + font)
                withOpacity(mark.style.opacity * mark.style.fillOpacity, &context) { ctx in
                    ctx.draw(
                        label(title, style: mark.style),
                        at: CGPoint(x: plot.midX, y: y),
                        anchor: .top
                    )
                }
            }

        case .y:
            let axisX = plot.minX
            var axisLine = Path()
            axisLine.move(to: CGPoint(x: axisX, y: plot.minY))
            axisLine.addLine(to: CGPoint(x: axisX, y: plot.maxY))
            paintStroke(axisLine, style: mark.style, into: &context)

            for tick in ticks {
                var tickMark = Path()
                tickMark.move(to: CGPoint(x: axisX - ChartDefaults.axisTickLength, y: tick.position))
                tickMark.addLine(to: CGPoint(x: axisX, y: tick.position))
                paintStroke(tickMark, style: mark.style, into: &context)

                if mark.grid {
                    var grid = Path()
                    grid.move(to: CGPoint(x: axisX, y: tick.position))
                    grid.addLine(to: CGPoint(x: plot.maxX, y: tick.position))
                    paintStroke(
                        grid, style: mark.style,
                        opacity: ChartDefaults.gridOpacity, into: &context
                    )
                }

                withOpacity(mark.style.opacity * mark.style.fillOpacity, &context) { ctx in
                    ctx.draw(
                        label(tick.text, style: mark.style),
                        at: CGPoint(x: axisX - 7, y: tick.position),
                        anchor: .trailing
                    )
                }
            }

            if let title = mark.axisLabel, !title.isEmpty {
                let text = label(title, style: mark.style)
                let alpha = mark.style.opacity * mark.style.fillOpacity
                context.drawLayer { layer in
                    layer.opacity = alpha
                    layer.translateBy(x: font, y: plot.midY)
                    layer.rotate(by: .degrees(-90))
                    layer.draw(text, at: .zero, anchor: .center)
                }
            }
        }
    }

    private static func drawRule(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        let plot = layout.plot
        var path = Path()
        if let y = mark.refY {
            guard let py = layout.y.map(y) else { return }
            path.move(to: CGPoint(x: plot.minX, y: py))
            path.addLine(to: CGPoint(x: plot.maxX, y: py))
        } else if let x = mark.refX {
            guard let px = layout.x.map(x) else { return }
            path.move(to: CGPoint(x: px, y: plot.minY))
            path.addLine(to: CGPoint(x: px, y: plot.maxY))
        } else {
            return
        }
        paintStroke(path, style: mark.style, into: &context)
    }

    private static func drawPath(
        _ mark: ChartMarkSpec, layout: ChartLayout, into context: inout GraphicsContext
    ) {
        guard let path = ChartPathBuilder.transformed(mark.pathData, layout: layout)
        else { return }
        paintFill(path, style: mark.style, opacity: mark.style.fillOpacity, into: &context)
        paintStroke(path, style: mark.style, into: &context)
    }

}

// MARK: - Hit shapes

/// A pre-computed hit region. `contentShape` takes any `Shape`, so a mark's
/// touch target can be exactly its geometry — a Line only answers near its
/// stroke and its vertices, never across the whole plot.
struct ChartHitShape: Shape {
    var resolved: Path

    func path(in rect: CGRect) -> Path { resolved }
}

extension ChartMarkSpec {

    /// The region a pointer must land in for this mark to answer.
    ///
    /// Vertices and points carry an invisible 12pt radius so fingers work.
    func hitPath(layout: ChartLayout) -> Path {
        let projected = ChartGeometry.project(data, layout: layout)
        var path = Path()

        switch kind {
        case .bars:
            for bar in ChartGeometry.bars(projected, layout: layout, ratio: barRatio) {
                // A zero-value bar still deserves a touch target.
                path.addRect(bar.rect.insetBy(dx: 0, dy: bar.rect.height < 2 ? -1 : 0))
            }

        case .points:
            let radius = Swift.max(pointRadius, ChartDefaults.hitRadius)
            for point in projected {
                path.addEllipse(in: touchRect(point.position, radius: radius))
            }

        case .line, .area:
            let points = projected.map { $0.position }
            if kind == .area, !points.isEmpty {
                path.addPath(
                    ChartPathBuilder.area(points, base: layout.zeroY, smooth: smooth)
                )
            } else if !points.isEmpty {
                let width = Swift.max(style.strokeWidth, 8)
                path.addPath(
                    ChartPathBuilder.line(points, smooth: smooth)
                        .strokedPath(
                            StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
                        )
                )
            }
            for point in points {
                path.addEllipse(in: touchRect(point, radius: ChartDefaults.hitRadius))
            }

        case .rule:
            let plot = layout.plot
            var line = Path()
            if let y = refY, let py = layout.y.map(y) {
                line.move(to: CGPoint(x: plot.minX, y: py))
                line.addLine(to: CGPoint(x: plot.maxX, y: py))
            } else if let x = refX, let px = layout.x.map(x) {
                line.move(to: CGPoint(x: px, y: plot.minY))
                line.addLine(to: CGPoint(x: px, y: plot.maxY))
            }
            path.addPath(line.strokedPath(StrokeStyle(lineWidth: 12)))

        case .axis:
            let plot = layout.plot
            path.addRect(
                axis == .x
                    ? CGRect(x: plot.minX, y: plot.maxY - 6, width: plot.width, height: 12)
                    : CGRect(x: plot.minX - 6, y: plot.minY, width: 12, height: plot.height)
            )

        case .path:
            if let drawn = ChartPathBuilder.transformed(pathData, layout: layout) {
                path.addPath(
                    drawn.strokedPath(StrokeStyle(lineWidth: Swift.max(style.strokeWidth, 8)))
                )
            }

        case .marker:
            break
        }
        return path
    }

    private func touchRect(_ center: CGPoint, radius: CGFloat) -> CGRect {
        CGRect(
            x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2
        )
    }
}

// MARK: - Gestures

/// Per-gesture bookkeeping that must survive a body re-evaluation without
/// invalidating the view: the hover latch, the move throttle and the
/// long-press latch.
final class ChartGestureTracker: @unchecked Sendable {
    var lastPoint: CGPoint?
    var touchActive = false
    var hoverActive = false
    var longPressFired = false
    private var lastMove: TimeInterval = 0

    init() {}

    /// `onMove` is throttled to roughly one frame, like the DOM applicator.
    func shouldEmitMove(now: TimeInterval = Date().timeIntervalSinceReferenceDate) -> Bool {
        if now - lastMove < ChartDefaults.moveThrottle { return false }
        lastMove = now
        return true
    }
}

/// The gesture plane shared by a mark's hit surface and the Chart's own
/// surface. `payload` turns a pointer location into the event's data-unit
/// payload; the static action arguments are merged underneath it.
@MainActor
struct ChartEventGestures: ViewModifier {
    let events: ChartMarkEvents
    let dispatcher: ActionDispatcher
    let payload: (CGPoint) -> [String: Any]

    @State private var tracker = ChartGestureTracker()

    func body(content: Content) -> some View {
        content
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        tracker.lastPoint = value.location
                        if !tracker.touchActive && !tracker.hoverActive {
                            tracker.touchActive = true
                            dispatch(events.hover, at: value.location)
                        } else {
                            tracker.touchActive = true
                        }
                        if tracker.shouldEmitMove() {
                            dispatch(events.move, at: value.location)
                        }
                    }
                    .onEnded { value in
                        tracker.lastPoint = value.location
                        if !tracker.longPressFired {
                            dispatch(events.click, at: value.location)
                        }
                        tracker.longPressFired = false
                        tracker.touchActive = false
                        // A pointer device keeps hovering after the click, so
                        // only a touch sequence ends with a leave.
                        if !tracker.hoverActive {
                            dispatch(events.leave, at: value.location)
                        }
                    }
            )
            .simultaneousGesture(
                LongPressGesture(minimumDuration: ChartDefaults.longPressDuration)
                    .onEnded { _ in
                        tracker.longPressFired = true
                        dispatch(events.longPress, at: tracker.lastPoint)
                    }
            )
            .chartContinuousHover { point in
                if let point = point {
                    tracker.lastPoint = point
                    if !tracker.hoverActive {
                        tracker.hoverActive = true
                        dispatch(events.hover, at: point)
                    }
                    if tracker.shouldEmitMove() {
                        dispatch(events.move, at: point)
                    }
                } else if tracker.hoverActive {
                    tracker.hoverActive = false
                    dispatch(events.leave, at: tracker.lastPoint)
                }
            }
    }

    /// Static action arguments first, the datum merged on top.
    private func dispatch(_ action: ActionValue?, at point: CGPoint?) {
        guard let action = action else { return }
        var merged = action.payload
        if let point = point {
            for (key, value) in payload(point) {
                merged[key] = value
            }
        }
        dispatcher.dispatch(action: action.actionName, payload: merged)
    }
}

extension View {
    /// Pointer hover with a location, where the platform has one. Touch
    /// hover/leave rides the drag gesture instead.
    @ViewBuilder
    func chartContinuousHover(_ handler: @escaping (CGPoint?) -> Void) -> some View {
        #if os(iOS) || os(macOS)
        if #available(iOS 16.0, macOS 13.0, *) {
            self.onContinuousHover { phase in
                switch phase {
                case .active(let point): handler(point)
                case .ended: handler(nil)
                @unknown default: handler(nil)
                }
            }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// One interactive mark's touch target.
@MainActor
struct ChartMarkHitView: View {
    let mark: ChartMarkSpec
    let layout: ChartLayout
    let dispatcher: ActionDispatcher

    var body: some View {
        Color.clear
            .contentShape(ChartHitShape(resolved: mark.hitPath(layout: layout)))
            .modifier(
                ChartEventGestures(
                    events: mark.events,
                    dispatcher: dispatcher,
                    payload: { point in
                        ChartHitTest.markPayload(
                            series: mark.series,
                            kind: mark.kind,
                            data: mark.data,
                            layout: layout,
                            barRatio: mark.barRatio,
                            pointRadius: mark.pointRadius,
                            point: point
                        ).dictionary
                    }
                )
            )
    }
}

/// The Chart's own event surface: events here carry the pointer position in
/// data units, for "add a point where I tapped" interactions.
@MainActor
struct ChartSurfaceGestures: View {
    let events: ChartMarkEvents
    let dispatcher: ActionDispatcher
    let payload: (CGPoint) -> [String: Any]

    var body: some View {
        Color.clear
            .contentShape(Rectangle())
            .modifier(
                ChartEventGestures(events: events, dispatcher: dispatcher, payload: payload)
            )
    }
}

// MARK: - Marker

/// A `Marker` pins ordinary Hypen children to a data point.
///
/// The content hangs off a zero-sized anchor view placed at the data point,
/// so `anchor:` is just which edge of that anchor the content aligns to,
/// plus an 8pt gap. `.fixedSize()` is what lets the content take its ideal
/// size out of a zero-sized proposal.
@MainActor
struct ChartMarkerView: View {
    let mark: ChartMarkSpec
    /// Observed directly: the Chart is notified of a Marker's own prop
    /// changes, but not of a child being inserted into or removed from it.
    @ObservedObject var element: HypenElement
    let layout: ChartLayout
    let renderer: HypenRenderer
    let dispatcher: ActionDispatcher

    var body: some View {
        if let placement = ChartGeometry.markerPlacement(
            x: mark.refX, y: mark.refY, anchor: mark.anchor, layout: layout
        ) {
            Color.clear
                .frame(width: 0, height: 0)
                .overlay(alignment: alignment(placement.anchor)) {
                    ZStack {
                        ForEach(element.children, id: \.self) { childId in
                            HypenElementView(
                                elementId: childId,
                                renderer: renderer,
                                actionDispatcher: dispatcher
                            )
                        }
                    }
                    .fixedSize()
                    .padding(gapEdge(placement.anchor), gap(placement.anchor))
                }
                .position(x: placement.point.x, y: placement.point.y)
                .allowsHitTesting(
                    ChartMarkSpec.subtreeHasEvents(element.id, renderer: renderer)
                )
        }
    }

    /// `top` means "content above the point", so the content's BOTTOM edge
    /// aligns with the anchor.
    private func alignment(_ anchor: ChartMarkerAnchor) -> Alignment {
        switch anchor {
        case .top: return .bottom
        case .bottom: return .top
        case .left: return .trailing
        case .right: return .leading
        case .center: return .center
        }
    }

    private func gapEdge(_ anchor: ChartMarkerAnchor) -> Edge.Set {
        switch anchor {
        case .top: return .bottom
        case .bottom: return .top
        case .left: return .trailing
        case .right: return .leading
        case .center: return []
        }
    }

    private func gap(_ anchor: ChartMarkerAnchor) -> CGFloat {
        anchor == .center ? 0 : ChartDefaults.markerGap
    }
}

import Foundation
import CoreGraphics

// ============================================================================
// Chart family — pure geometry
// ============================================================================
//
// Everything in this file is deliberately free of SwiftUI, AppKit/UIKit and
// MainActor isolation: data normalisation, domain resolution, nice ticks,
// plot insets, mark geometry, hit resolution and Marker placement are all
// value types that can be unit-tested without a window or a draw pass.
// `ChartComponents.swift` is the thin SwiftUI `Canvas` + gesture shell that
// feeds them.
//
// Contract: `hypen-docs/content/docs/guide/charts.mdx`.
// Reference implementation (numbers ported verbatim):
// `hypen-web/packages/web/src/dom/components/chart.ts`.
// Behaviours pinned by: `hypen-web/tests/dom.chart-contract.test.ts`.

// MARK: - Constants

/// The normative chart defaults, mirrored from `CHART_DEFAULTS` in
/// `hypen-web/packages/web/src/dom/components/chart.ts`. Keep the two in
/// sync — they are the same contract expressed twice.
enum ChartDefaults {
    /// Fallback host size when neither a prop nor the parent supplies one.
    static let width: CGFloat = 320
    static let height: CGFloat = 200

    /// Plot inset when no axis asks for label room (sparkline mode).
    static let bareInset: CGFloat = 4
    static let insetTop: CGFloat = 10
    static let insetRight: CGFloat = 12
    /// Room for a y axis' tick labels.
    static let insetLeft: CGFloat = 44
    /// Room for an x axis' tick labels.
    static let insetBottom: CGFloat = 28

    static let ticks: Int = 5
    static let pointRadius: CGFloat = 3.5
    /// Invisible touch target radius around a point or line vertex.
    static let hitRadius: CGFloat = 12
    static let barWidth: Double = 0.7
    static let dimmedOpacity: Double = 0.45
    static let fontSize: CGFloat = 11

    // Per-mark presentation defaults (`MARK_DEFAULT_ATTRS` on the web).
    static let lineStrokeWidth: CGFloat = 2
    static let areaFillOpacity: Double = 0.15
    static let axisStrokeWidth: CGFloat = 1
    static let axisStrokeOpacity: Double = 0.5
    static let axisTextOpacity: Double = 0.75
    static let axisTickLength: CGFloat = 4
    static let gridOpacity: Double = 0.15
    static let ruleStrokeWidth: CGFloat = 1
    static let ruleStrokeOpacity: Double = 0.7
    static let ruleDash: [CGFloat] = [4, 4]
    static let pathStrokeWidth: CGFloat = 2

    /// Gap between a Marker's data point and its content, per anchor.
    static let markerGap: CGFloat = 8
    /// `.glow()` with no radius.
    static let glowRadius: CGFloat = 6

    /// `.onLongPress` fires after this many seconds.
    static let longPressDuration: Double = 0.5
    /// `.onMove` is throttled to roughly one frame.
    static let moveThrottle: Double = 0.032
}

// MARK: - JSON values

/// A Sendable, Equatable stand-in for a decoded JSON value.
///
/// Props arrive as `[String: Any]` off the wire. The chart has to carry the
/// *original* row all the way into an action payload (`datum`), and the
/// SwiftUI `Canvas` draw closure may only capture Sendable values, so every
/// prop the chart keeps is normalised into this enum first and turned back
/// into `Any` only when a payload dictionary is built.
enum ChartJSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([ChartJSON])
    case object([String: ChartJSON])

    /// Normalise one `Any` prop value.
    static func from(_ value: Any?) -> ChartJSON {
        guard let value = value else { return .null }
        if value is NSNull { return .null }
        if let string = value as? String { return .string(string) }
        // NSNumber first: JSON booleans and numbers both bridge to NSNumber,
        // and `1 as? Bool` succeeds for a bridged number. CFBoolean is the
        // only reliable way to tell them apart.
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            return .number(number.doubleValue)
        }
        if let bool = value as? Bool { return .bool(bool) }
        if let int = value as? Int { return .number(Double(int)) }
        if let double = value as? Double { return .number(double) }
        if let float = value as? CGFloat { return .number(Double(float)) }
        if let list = value as? [Any] { return .array(list.map { ChartJSON.from($0) }) }
        if let map = value as? [String: Any] { return .object(map.mapValues { ChartJSON.from($0) }) }
        return .string(String(describing: value))
    }

    /// Normalise a whole prop bag.
    static func props(_ props: [String: Any]) -> [String: ChartJSON] {
        props.mapValues { ChartJSON.from($0) }
    }

    /// Back to a JSON-serialisable `Any`, for an action payload.
    var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let bool): return bool
        case .number(let number):
            // Keep whole numbers whole on the wire: an index or a count
            // should not arrive at a module handler as `3.0`.
            if number.rounded() == number, abs(number) < 9_007_199_254_740_992 {
                return Int(number)
            }
            return number
        case .string(let string): return string
        case .array(let list): return list.map { $0.anyValue }
        case .object(let map): return map.mapValues { $0.anyValue }
        }
    }

    /// JS `Number(value)` semantics, restricted to what a chart accepts:
    /// finite numbers, and non-blank numeric strings. Booleans are not
    /// numbers here (the reference implementation rejects them too).
    var numberValue: Double? {
        switch self {
        case .number(let number): return number.isFinite ? number : nil
        case .string(let string):
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite else { return nil }
            return value
        default: return nil
        }
    }

    var stringValue: String? {
        if case .string(let string) = self { return string }
        return nil
    }

    var arrayValue: [ChartJSON]? {
        if case .array(let list) = self { return list }
        return nil
    }

    var isNull: Bool { self == .null }

    /// Parse a JSON-encoded list. A list literal can arrive JSON-encoded
    /// over the wire, which is how remote apps send `points:`.
    var decodedList: [ChartJSON]? {
        if case .array(let list) = self { return list }
        guard case .string(let string) = self,
              let data = string.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(
                  with: data, options: [.fragmentsAllowed]
              ),
              let list = parsed as? [Any]
        else { return nil }
        return list.map { ChartJSON.from($0) }
    }
}

// MARK: - Data

/// A datum's x: a number, or a category name (which switches the x scale to
/// bands for the whole chart).
enum ChartX: Equatable, Sendable {
    case number(Double)
    case category(String)

    /// x keeps strings (categories); anything numeric stays numeric, so a
    /// numeric *string* is a number, not a category.
    static func from(_ value: ChartJSON) -> ChartX? {
        if let number = value.numberValue { return .number(number) }
        if case .string(let string) = value, !string.isEmpty { return .category(string) }
        return nil
    }

    var numberValue: Double? {
        if case .number(let number) = self { return number }
        return nil
    }

    var categoryValue: String? {
        if case .category(let string) = self { return string }
        return nil
    }

    /// The band scale keys categories by their string form, so a numeric x
    /// can still land on a category named `"1"` — matching the reference.
    var stringKey: String {
        switch self {
        case .category(let string): return string
        case .number(let number):
            if number.rounded() == number, abs(number) < 9_007_199_254_740_992 {
                return String(Int(number))
            }
            return String(number)
        }
    }

    var anyValue: Any {
        switch self {
        case .category(let string): return string
        case .number(let number):
            if number.rounded() == number, abs(number) < 9_007_199_254_740_992 {
                return Int(number)
            }
            return number
        }
    }
}

/// One normalised row: `{x, y}` plus its position in the bound array and the
/// original row, which travels untouched into the event payload.
struct ChartDatum: Equatable, Sendable {
    var x: ChartX
    var y: Double
    var index: Int
    var raw: ChartJSON
}

enum ChartMarkKind: String, CaseIterable, Sendable {
    case line
    case area
    case bars
    case points
    case axis
    case rule
    case marker
    case path

    static func named(_ name: String?) -> ChartMarkKind? {
        guard let name = name else { return nil }
        return ChartMarkKind(rawValue: name.lowercased())
    }

    /// Marks that carry data and therefore take part in domain resolution.
    var isDataMark: Bool {
        switch self {
        case .line, .area, .bars, .points: return true
        case .axis, .rule, .marker, .path: return false
        }
    }
}

enum ChartAxisKind: String, Sendable {
    case x
    case y
}

/// Data normalisation and prop reading, ported from `normalizeData`.
enum ChartData {

    /// A prop under either spelling: the plain named-argument key, or the
    /// engine's positional `"<name>.0"` form.
    static func prop(_ props: [String: ChartJSON], _ name: String) -> ChartJSON? {
        if let value = props[name], !value.isNull { return value }
        if let value = props["\(name).0"], !value.isNull { return value }
        return nil
    }

    /// The mark's row list: `points:` / `data:` / `values:` / positional.
    static func readList(_ props: [String: ChartJSON]) -> [ChartJSON] {
        for name in ["points", "data", "values"] {
            if let value = prop(props, name), let list = value.decodedList { return list }
        }
        if let value = props["0"], let list = value.decodedList { return list }
        return []
    }

    /// Field name for object rows. `x:`/`y:` name the fields; Bars also
    /// accepts the `label:`/`value:` sugar.
    static func fieldName(
        _ props: [String: ChartJSON], primary: String, sugar: String, fallback: String
    ) -> String {
        if let name = prop(props, primary)?.stringValue, !name.isEmpty { return name }
        if let name = prop(props, sugar)?.stringValue, !name.isEmpty { return name }
        return fallback
    }

    /// Normalise the mark's list prop into `{x, y}` data.
    ///
    /// - a bare number → `{x: index, y: n}`
    /// - an `[x, y]` tuple
    /// - an object → field names from `x:`/`y:` (or `label:`/`value:`);
    ///   a missing x *field* falls back to the index
    ///
    /// Rows without a numeric y are dropped, never zeroed.
    static func normalize(_ props: [String: ChartJSON]) -> [ChartDatum] {
        let list = readList(props)
        let xField = fieldName(props, primary: "x", sugar: "label", fallback: "x")
        let yField = fieldName(props, primary: "y", sugar: "value", fallback: "y")

        var out: [ChartDatum] = []
        out.reserveCapacity(list.count)
        for (index, raw) in list.enumerated() {
            var x: ChartX?
            var y: Double?

            switch raw {
            case .array(let tuple):
                x = tuple.count > 0 ? ChartX.from(tuple[0]) : nil
                y = tuple.count > 1 ? tuple[1].numberValue : nil
            case .object(let row):
                x = row[xField].flatMap { ChartX.from($0) }
                y = row[yField]?.numberValue
                if x == nil && row[xField] == nil { x = .number(Double(index)) }
            default:
                x = .number(Double(index))
                y = raw.numberValue
            }

            guard let resolvedX = x, let resolvedY = y else { continue }
            out.append(ChartDatum(x: resolvedX, y: resolvedY, index: index, raw: raw))
        }
        return out
    }

    /// Convenience for callers holding raw engine props.
    static func normalize(anyProps: [String: Any]) -> [ChartDatum] {
        normalize(ChartJSON.props(anyProps))
    }

    /// An explicit `[min, max]` domain, ordered low→high. A JSON-encoded
    /// list is accepted, like every other list prop.
    static func readRange(_ value: ChartJSON?) -> (Double, Double)? {
        guard let list = value?.decodedList, list.count >= 2,
              let a = list[0].numberValue, let b = list[1].numberValue
        else { return nil }
        return a <= b ? (a, b) : (b, a)
    }

    /// `highlight` = index | [indices] | null.
    static func highlightSet(_ value: ChartJSON?) -> Set<Int>? {
        guard let value = value else { return nil }
        switch value {
        case .null: return nil
        case .bool(let bool): return bool ? Set<Int>() : nil
        case .string(let string) where string.isEmpty: return nil
        default: break
        }
        let items = value.decodedList ?? [value]
        var out = Set<Int>()
        for item in items {
            if let number = item.numberValue { out.insert(Int(number)) }
        }
        return out
    }

    /// `Axis(x)` / `Axis(y)` / `Axis(axis: "y")`. Anything else is an x axis.
    static func axisKind(_ props: [String: ChartJSON]) -> ChartAxisKind {
        let raw = prop(props, "axis") ?? props["0"]
        let name = raw?.stringValue ?? ""
        return name.lowercased() == "y" ? .y : .x
    }

    /// JS truthiness for the flags a mark accepts (`smooth`, `grid`).
    static func flag(_ value: ChartJSON?) -> Bool {
        guard let value = value else { return false }
        switch value {
        case .bool(let bool): return bool
        case .number(let number): return number != 0
        case .string(let string):
            let lowered = string.lowercased()
            return !(lowered.isEmpty || lowered == "false" || lowered == "0")
        case .null: return false
        case .array, .object: return true
        }
    }
}

// MARK: - Scales

/// Data → pixel mapping for one axis. `y` runs bottom→top, so its range
/// start is greater than its range end.
struct ChartScale: Equatable, Sendable {
    enum Kind: String, Equatable, Sendable {
        case linear
        case band
    }

    var kind: Kind
    var min: Double
    var max: Double
    var categories: [String]
    var rangeStart: CGFloat
    var rangeEnd: CGFloat
    /// Width of one categorical band, or the pixel step implied by bar count.
    var band: CGFloat

    static func makeLinear(min: Double, max: Double, range: (CGFloat, CGFloat)) -> ChartScale {
        ChartScale(
            kind: .linear, min: min, max: max, categories: [],
            rangeStart: range.0, rangeEnd: range.1, band: 0
        )
    }

    static func makeBand(categories: [String], range: (CGFloat, CGFloat)) -> ChartScale {
        let count = Swift.max(categories.count, 1)
        let width = range.1 - range.0
        return ChartScale(
            kind: .band, min: 0, max: Double(count), categories: categories,
            rangeStart: range.0, rangeEnd: range.1, band: width / CGFloat(count)
        )
    }

    private var span: Double {
        let raw = max - min
        return raw == 0 ? 1 : raw
    }

    private var pixelSpan: CGFloat { rangeEnd - rangeStart }

    /// Data → pixel. Nil for a category the scale does not know.
    func map(_ value: ChartX) -> CGFloat? {
        switch kind {
        case .linear:
            guard let number = value.numberValue else { return nil }
            return map(number)
        case .band:
            guard let index = categories.firstIndex(of: value.stringKey) else { return nil }
            return rangeStart + (CGFloat(index) + 0.5) * band
        }
    }

    func map(_ value: Double) -> CGFloat? {
        switch kind {
        case .linear:
            return rangeStart + CGFloat((value - min) / span) * pixelSpan
        case .band:
            return map(ChartX.number(value))
        }
    }

    /// Pixel → data (numeric position; band index for categorical).
    func invert(_ px: CGFloat) -> Double {
        switch kind {
        case .linear:
            let denominator = pixelSpan == 0 ? 1 : pixelSpan
            return min + Double((px - rangeStart) / denominator) * span
        case .band:
            let denominator = band == 0 ? 1 : band
            return Double((px - rangeStart) / denominator)
        }
    }

    /// The category a pointer x lands in, clamped to the ends.
    func category(at px: CGFloat) -> String? {
        guard kind == .band, !categories.isEmpty else { return nil }
        let raw = Int(invert(px).rounded(.down))
        return categories[Swift.min(Swift.max(raw, 0), categories.count - 1)]
    }
}

// MARK: - Nice ticks

enum ChartMath {

    /// Round a domain out to tick-friendly bounds.
    static func niceDomain(_ min: Double, _ max: Double, _ count: Int) -> (Double, Double) {
        if min == max {
            let pad = min == 0 ? 1 : abs(min) * 0.1
            return (min - pad, max + pad)
        }
        let step = niceStep(min, max, count)
        return ((min / step).rounded(.down) * step, (max / step).rounded(.up) * step)
    }

    /// The 1/2/5-family step whose tick count lands nearest `count` (d3's
    /// thresholds).
    static func niceStep(_ min: Double, _ max: Double, _ count: Int) -> Double {
        let raw = (max - min) / Double(Swift.max(count, 1))
        guard raw > 0, raw.isFinite else { return 1 }
        let magnitude = pow(10, (log10(raw)).rounded(.down))
        let normalised = raw / magnitude
        let nice: Double = normalised < 1.5 ? 1 : normalised < 3 ? 2 : normalised < 7 ? 5 : 10
        return nice * magnitude
    }

    /// Tick values inside `[min, max]`, at multiples of the nice step.
    static func ticks(_ min: Double, _ max: Double, _ count: Int) -> [Double] {
        if min == max { return [min] }
        let step = niceStep(min, max, count)
        guard step > 0 else { return [min] }
        var out: [Double] = []
        var value = (min / step).rounded(.up) * step
        // A guard against a pathological step producing an unbounded loop.
        var guardCount = 0
        while value <= max + step * 1e-9 && guardCount < 10_000 {
            out.append(roundTick(value))
            value += step
            guardCount += 1
        }
        return out
    }

    /// JS `Number(v.toPrecision(12))`, which is what keeps 0.1 + 0.2 steps
    /// from printing as 0.30000000000000004.
    static func roundTick(_ value: Double) -> Double {
        if abs(value) < 1e-9 { return 0 }
        return Double(String(format: "%.12g", value)) ?? value
    }

    /// Tick label text: integers stay bare, everything else is trimmed to
    /// three decimals with trailing zeros removed.
    static func formatTick(_ value: Double) -> String {
        if value.rounded() == value, abs(value) < 9_007_199_254_740_992 {
            return String(Int(value))
        }
        var text = String(format: "%.3f", value)
        if text.contains(".") {
            while text.hasSuffix("0") { text.removeLast() }
            if text.hasSuffix(".") { text.removeLast() }
        }
        return text
    }
}

// MARK: - Layout

/// Plot insets, in points.
struct ChartInsets: Equatable, Sendable {
    var top: CGFloat
    var right: CGFloat
    var bottom: CGFloat
    var left: CGFloat

    static func resolve(padding: Double?, hasXAxis: Bool, hasYAxis: Bool) -> ChartInsets {
        if let padding = padding {
            let value = CGFloat(padding)
            return ChartInsets(top: value, right: value, bottom: value, left: value)
        }
        if !hasXAxis && !hasYAxis {
            let bare = ChartDefaults.bareInset
            return ChartInsets(top: bare, right: bare, bottom: bare, left: bare)
        }
        return ChartInsets(
            top: ChartDefaults.insetTop,
            right: ChartDefaults.insetRight,
            bottom: hasXAxis ? ChartDefaults.insetBottom : ChartDefaults.bareInset,
            left: hasYAxis ? ChartDefaults.insetLeft : ChartDefaults.bareInset
        )
    }
}

/// The domain-relevant slice of a mark, all a layout pass needs.
struct ChartMarkInput: Equatable, Sendable {
    var kind: ChartMarkKind
    var data: [ChartDatum]
    /// Axis marks only.
    var axis: ChartAxisKind?
    /// Rule / Marker coordinates, which also widen the domain.
    var refX: ChartX?
    var refY: Double?

    init(
        kind: ChartMarkKind,
        data: [ChartDatum] = [],
        axis: ChartAxisKind? = nil,
        refX: ChartX? = nil,
        refY: Double? = nil
    ) {
        self.kind = kind
        self.data = data
        self.axis = axis
        self.refX = refX
        self.refY = refY
    }
}

/// A resolved chart: the plot rect plus both scales.
struct ChartLayout: Equatable, Sendable {
    var size: CGSize
    var plot: CGRect
    var x: ChartScale
    var y: ChartScale

    /// The pixel row the bars and areas grow from: zero, clamped into the
    /// y domain so a chart that never reaches zero still has a baseline.
    var zeroY: CGFloat {
        let value = Swift.min(Swift.max(0, y.min), y.max)
        return y.map(value) ?? plot.maxY
    }

    /// Resolve domains and insets. Explicit chart ranges win; otherwise the
    /// domain is the union of the marks' data.
    static func resolve(
        size: CGSize,
        padding: Double?,
        explicitX: (Double, Double)?,
        explicitY: (Double, Double)?,
        marks: [ChartMarkInput]
    ) -> ChartLayout {
        let hasXAxis = marks.contains { $0.kind == .axis && ($0.axis ?? .x) == .x }
        let hasYAxis = marks.contains { $0.kind == .axis && ($0.axis ?? .x) == .y }
        let insets = ChartInsets.resolve(padding: padding, hasXAxis: hasXAxis, hasYAxis: hasYAxis)

        let plot = CGRect(
            x: insets.left,
            y: insets.top,
            width: Swift.max(size.width - insets.left - insets.right, 1),
            height: Swift.max(size.height - insets.top - insets.bottom, 1)
        )
        let xRange: (CGFloat, CGFloat) = (plot.minX, plot.maxX)
        let yRange: (CGFloat, CGFloat) = (plot.maxY, plot.minY)

        var categories: [String] = []
        var seen = Set<String>()
        var xMin = Double.infinity
        var xMax = -Double.infinity
        var yMin = Double.infinity
        var yMax = -Double.infinity
        var anyData = false
        var bars = 0

        for mark in marks {
            if mark.kind == .bars {
                bars = Swift.max(bars, mark.data.count)
                // Bars grow from zero: a bar chart whose data never touches
                // 0 still has to show 0 or the bar heights lie.
                yMin = Swift.min(yMin, 0)
                yMax = Swift.max(yMax, 0)
            }
            if mark.kind.isDataMark {
                for datum in mark.data {
                    anyData = true
                    switch datum.x {
                    case .category(let name):
                        if !seen.contains(name) {
                            seen.insert(name)
                            categories.append(name)
                        }
                    case .number(let value):
                        xMin = Swift.min(xMin, value)
                        xMax = Swift.max(xMax, value)
                    }
                    yMin = Swift.min(yMin, datum.y)
                    yMax = Swift.max(yMax, datum.y)
                }
            }
            if mark.kind == .rule || mark.kind == .marker {
                if let refY = mark.refY {
                    yMin = Swift.min(yMin, refY)
                    yMax = Swift.max(yMax, refY)
                }
                if let value = mark.refX?.numberValue {
                    xMin = Swift.min(xMin, value)
                    xMax = Swift.max(xMax, value)
                }
            }
        }

        var x: ChartScale
        if !categories.isEmpty {
            x = ChartScale.makeBand(categories: categories, range: xRange)
        } else {
            var lo: Double
            var hi: Double
            if let explicitX = explicitX {
                (lo, hi) = explicitX
            } else if xMin.isFinite {
                (lo, hi) = (xMin, xMax)
            } else {
                (lo, hi) = (0, 1)
            }
            if lo == hi {
                lo -= 1
                hi += 1
            }
            x = ChartScale.makeLinear(min: lo, max: hi, range: xRange)
            // Numeric bars need a step to size their width from.
            let width = xRange.1 - xRange.0
            x.band = bars > 1 ? width / CGFloat(bars) : (bars == 1 ? width / 2 : 0)
        }

        let y: ChartScale
        if let explicitY = explicitY {
            y = ChartScale.makeLinear(min: explicitY.0, max: explicitY.1, range: yRange)
        } else if yMin.isFinite {
            let bounds = (anyData || bars > 0)
                ? ChartMath.niceDomain(yMin, yMax, ChartDefaults.ticks)
                : (yMin, yMax)
            y = ChartScale.makeLinear(min: bounds.0, max: bounds.1, range: yRange)
        } else {
            y = ChartScale.makeLinear(min: 0, max: 1, range: yRange)
        }

        return ChartLayout(size: size, plot: plot, x: x, y: y)
    }
}

// MARK: - Mark geometry

/// One datum projected into plot pixels.
struct ChartProjectedPoint: Equatable, Sendable {
    var position: CGPoint
    var index: Int
}

/// One bar's rect plus the row it came from.
struct ChartBar: Equatable, Sendable {
    var index: Int
    var rect: CGRect
}

/// One axis tick: where it sits in pixels and what it is labelled.
struct ChartAxisTick: Equatable, Sendable {
    var position: CGFloat
    var text: String
}

/// A Catmull-Rom span expressed as a cubic Bézier.
struct ChartCubic: Equatable, Sendable {
    var control1: CGPoint
    var control2: CGPoint
    var end: CGPoint
}

enum ChartGeometry {

    /// Data → pixels, dropping rows the scales cannot place (an unknown
    /// category, say).
    static func project(_ data: [ChartDatum], layout: ChartLayout) -> [ChartProjectedPoint] {
        var out: [ChartProjectedPoint] = []
        out.reserveCapacity(data.count)
        for datum in data {
            guard let px = layout.x.map(datum.x), let py = layout.y.map(datum.y) else { continue }
            out.append(ChartProjectedPoint(position: CGPoint(x: px, y: py), index: datum.index))
        }
        return out
    }

    /// The pixel step one bar occupies: the band width, or the plot split
    /// evenly across the rows.
    static func barStep(layout: ChartLayout, count: Int) -> CGFloat {
        if layout.x.band > 0 { return layout.x.band }
        return layout.plot.width / CGFloat(max(count, 1))
    }

    /// One rect per row, centred on x, growing from the zero line.
    static func bars(
        _ points: [ChartProjectedPoint],
        layout: ChartLayout,
        ratio: Double
    ) -> [ChartBar] {
        guard !points.isEmpty else { return [] }
        let step = barStep(layout: layout, count: points.count)
        let clamped = Swift.min(Swift.max(ratio, 0.05), 1)
        let width = Swift.max(step * CGFloat(clamped), 1)
        let zero = layout.zeroY
        return points.map { point in
            let top = Swift.min(point.position.y, zero)
            let height = abs(zero - point.position.y)
            return ChartBar(
                index: point.index,
                rect: CGRect(x: point.position.x - width / 2, y: top, width: width, height: height)
            )
        }
    }

    /// Catmull-Rom → cubic Bézier, the usual "smooth" line. Fewer than three
    /// points is a straight polyline.
    static func smoothSegments(_ points: [CGPoint]) -> [ChartCubic] {
        guard points.count >= 3 else { return [] }
        var out: [ChartCubic] = []
        out.reserveCapacity(points.count - 1)
        for i in 0..<(points.count - 1) {
            let p0 = points[Swift.max(i - 1, 0)]
            let p1 = points[i]
            let p2 = points[i + 1]
            let p3 = points[Swift.min(i + 2, points.count - 1)]
            out.append(
                ChartCubic(
                    control1: CGPoint(
                        x: p1.x + (p2.x - p0.x) / 6,
                        y: p1.y + (p2.y - p0.y) / 6
                    ),
                    control2: CGPoint(
                        x: p2.x - (p3.x - p1.x) / 6,
                        y: p2.y - (p3.y - p1.y) / 6
                    ),
                    end: p2
                )
            )
        }
        return out
    }

    /// The affine transform that takes a `Path` mark's data-unit coordinates
    /// into plot pixels. y flips because pixels grow downwards.
    static func pathTransform(layout: ChartLayout) -> CGAffineTransform {
        let xSpan = layout.x.max - layout.x.min
        let ySpan = layout.y.max - layout.y.min
        let sx = (layout.x.rangeEnd - layout.x.rangeStart) / CGFloat(xSpan == 0 ? 1 : xSpan)
        let sy = (layout.y.rangeEnd - layout.y.rangeStart) / CGFloat(ySpan == 0 ? 1 : ySpan)
        let tx = layout.x.rangeStart - CGFloat(layout.x.min) * sx
        let ty = layout.y.rangeStart - CGFloat(layout.y.min) * sy
        return CGAffineTransform(a: sx, b: 0, c: 0, d: sy, tx: tx, ty: ty)
    }

    /// Axis tick positions and labels. An x band scale labels every
    /// category; everything else labels nice ticks.
    static func axisTicks(
        _ axis: ChartAxisKind, layout: ChartLayout, count: Int
    ) -> [ChartAxisTick] {
        switch axis {
        case .x:
            if layout.x.kind == .band {
                return layout.x.categories.map { category in
                    ChartAxisTick(
                        position: layout.x.map(ChartX.category(category)) ?? 0,
                        text: category
                    )
                }
            }
            return ChartMath.ticks(layout.x.min, layout.x.max, count).map { value in
                ChartAxisTick(
                    position: layout.x.map(value) ?? 0,
                    text: ChartMath.formatTick(value)
                )
            }
        case .y:
            return ChartMath.ticks(layout.y.min, layout.y.max, count).map { value in
                ChartAxisTick(
                    position: layout.y.map(value) ?? 0,
                    text: ChartMath.formatTick(value)
                )
            }
        }
    }
}

// MARK: - Marker placement

/// Where a Marker's content sits relative to its data point.
enum ChartMarkerAnchor: String, CaseIterable, Sendable {
    case top
    case bottom
    case left
    case right
    case center

    /// `top` is the default: content above the point.
    static func named(_ name: String?) -> ChartMarkerAnchor {
        guard let name = name, let anchor = ChartMarkerAnchor(rawValue: name.lowercased()) else {
            return .top
        }
        return anchor
    }
}

struct ChartMarkerPlacement: Equatable, Sendable {
    var point: CGPoint
    var anchor: ChartMarkerAnchor
}

extension ChartGeometry {

    /// Resolve a Marker's pixel position.
    ///
    /// No coordinates at all (a tooltip bound to `state.hover` while it is
    /// null) hides the marker. One missing coordinate centres it on that
    /// axis, so `Marker(y: 80) { Text("goal") }` sits mid-plot at the goal
    /// level.
    static func markerPlacement(
        x: ChartX?, y: Double?, anchor: ChartMarkerAnchor, layout: ChartLayout
    ) -> ChartMarkerPlacement? {
        if x == nil && y == nil { return nil }
        var px: CGFloat? = layout.plot.midX
        var py: CGFloat? = layout.plot.midY
        if let x = x { px = layout.x.map(x) }
        if let y = y { py = layout.y.map(y) }
        guard let resolvedX = px, let resolvedY = py else { return nil }
        return ChartMarkerPlacement(
            point: CGPoint(x: resolvedX, y: resolvedY), anchor: anchor
        )
    }
}

// MARK: - Interaction

/// The payload every event on a mark carries, in data units.
///
/// `{series, index, x, y, datum}` — merged on top of the mark's static
/// action arguments by the caller.
struct ChartMarkPayload: Equatable, Sendable {
    var series: String
    var index: Int?
    var x: ChartX?
    var y: Double?
    var datum: ChartJSON?

    var dictionary: [String: Any] {
        var out: [String: Any] = ["series": series]
        if let index = index { out["index"] = index }
        if let x = x { out["x"] = x.anyValue }
        if let y = y { out["y"] = ChartJSON.number(y).anyValue }
        if let datum = datum { out["datum"] = datum.anyValue }
        return out
    }
}

/// A chart-level event's pointer position, in data units.
struct ChartPointerPayload: Equatable, Sendable {
    var x: ChartX
    var y: Double

    var dictionary: [String: Any] {
        ["x": x.anyValue, "y": ChartJSON.number(y).anyValue]
    }
}

enum ChartHitTest {

    /// The row a pointer landed *on*: inside a bar, within a point's touch
    /// radius, or within a line/area vertex's touch radius. Nil when the
    /// pointer is merely somewhere over the mark.
    static func directHit(
        kind: ChartMarkKind,
        data: [ChartDatum],
        layout: ChartLayout,
        barRatio: Double,
        pointRadius: CGFloat,
        point: CGPoint
    ) -> Int? {
        let projected = ChartGeometry.project(data, layout: layout)
        guard !projected.isEmpty else { return nil }

        switch kind {
        case .bars:
            for bar in ChartGeometry.bars(projected, layout: layout, ratio: barRatio).reversed() {
                // A zero-height bar (value 0) still deserves a touch target.
                let target = bar.rect.insetBy(dx: 0, dy: bar.rect.height < 1 ? -1 : 0)
                if target.contains(point) { return bar.index }
            }
            return nil

        case .points:
            let radius = Swift.max(pointRadius, ChartDefaults.hitRadius)
            return nearestWithin(projected, point: point, radius: radius)

        case .line, .area:
            return nearestWithin(projected, point: point, radius: ChartDefaults.hitRadius)

        case .axis, .rule, .marker, .path:
            return nil
        }
    }

    private static func nearestWithin(
        _ points: [ChartProjectedPoint], point: CGPoint, radius: CGFloat
    ) -> Int? {
        var best: Int?
        var bestDistance = CGFloat.infinity
        for candidate in points {
            let dx = candidate.position.x - point.x
            let dy = candidate.position.y - point.y
            let distance = (dx * dx + dy * dy).squareRoot()
            if distance <= radius && distance < bestDistance {
                bestDistance = distance
                best = candidate.index
            }
        }
        return best
    }

    /// The row nearest the pointer along x — what a hit anywhere else on a
    /// data mark resolves to, so a finger landing between two vertices still
    /// gets a useful answer.
    static func nearestAlongX(
        data: [ChartDatum], layout: ChartLayout, pointerX: CGFloat
    ) -> Int? {
        var best: Int?
        var bestDistance = CGFloat.infinity
        for datum in data {
            guard let px = layout.x.map(datum.x) else { continue }
            let distance = abs(px - pointerX)
            if distance < bestDistance {
                bestDistance = distance
                best = datum.index
            }
        }
        return best
    }

    /// Resolve the datum an event refers to: an explicit hit on a bar, point
    /// or vertex wins; otherwise the row nearest the pointer along x. A mark
    /// with no data, or a non-data mark, resolves to `{series}` only.
    static func markPayload(
        series: String,
        kind: ChartMarkKind,
        data: [ChartDatum],
        layout: ChartLayout,
        barRatio: Double,
        pointRadius: CGFloat,
        point: CGPoint?
    ) -> ChartMarkPayload {
        var payload = ChartMarkPayload(series: series)
        guard kind.isDataMark, !data.isEmpty, let point = point else { return payload }

        let index = directHit(
            kind: kind, data: data, layout: layout,
            barRatio: barRatio, pointRadius: pointRadius, point: point
        ) ?? nearestAlongX(data: data, layout: layout, pointerX: point.x)

        guard let index = index, let datum = data.first(where: { $0.index == index }) else {
            return payload
        }
        payload.index = datum.index
        payload.x = datum.x
        payload.y = datum.y
        payload.datum = datum.raw
        return payload
    }

    /// Chart-level events carry the pointer position in data units; a band
    /// x resolves to the category name.
    static func chartPayload(layout: ChartLayout, point: CGPoint) -> ChartPointerPayload {
        let x: ChartX
        if layout.x.kind == .band, let category = layout.x.category(at: point.x) {
            x = .category(category)
        } else {
            x = .number(layout.x.invert(point.x))
        }
        return ChartPointerPayload(x: x, y: layout.y.invert(point.y))
    }
}

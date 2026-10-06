import CoreGraphics
import Foundation
import SwiftUI
import XCTest
@testable import HypenSwift

/// Chart family — the pure geometry behind `ChartComponent` and its marks.
///
/// Contract: `hypen-docs/content/docs/guide/charts.mdx`. The numbers below
/// are the same ones pinned on the web renderer by
/// `hypen-web/tests/dom.chart-contract.test.ts`, so a datum resolved here and
/// a datum resolved there reach a module handler identically.
///
/// Everything asserted is renderer-independent by construction: the SwiftUI
/// `Canvas` + gesture shell only feeds these types and paints their output.

// MARK: - Shared fixtures

/// The default host box the web tests use: 320×200 with no axes, so the
/// plot is inset 4 all round → 4…316 × 4…196.
private let chartSize = CGSize(width: ChartDefaults.width, height: ChartDefaults.height)
private let plotLeft: CGFloat = ChartDefaults.bareInset
private let plotRight: CGFloat = ChartDefaults.width - ChartDefaults.bareInset
private let plotTop: CGFloat = ChartDefaults.bareInset
private let plotBottom: CGFloat = ChartDefaults.height - ChartDefaults.bareInset

private func props(_ dict: [String: Any]) -> [String: ChartJSON] {
    ChartJSON.props(dict)
}

private func data(_ dict: [String: Any]) -> [ChartDatum] {
    ChartData.normalize(anyProps: dict)
}

private func layout(
    _ marks: [ChartMarkInput],
    size: CGSize = chartSize,
    padding: Double? = nil,
    x: (Double, Double)? = nil,
    y: (Double, Double)? = nil
) -> ChartLayout {
    ChartLayout.resolve(size: size, padding: padding, explicitX: x, explicitY: y, marks: marks)
}

// MARK: - Data normalisation

final class ChartDataNormalisationTests: XCTestCase {

    func testBareNumberListUsesTheIndexAsX() {
        let rows = data(["points": [3, 5, 2]])
        XCTAssertEqual(rows.map { $0.x }, [.number(0), .number(1), .number(2)])
        XCTAssertEqual(rows.map { $0.y }, [3, 5, 2])
    }

    func testTupleRows() {
        let rows = data(["0": [[10, 1], [20, 4]]])
        XCTAssertEqual(rows.map { $0.x }, [.number(10), .number(20)])
        XCTAssertEqual(rows.map { $0.y }, [1, 4])
    }

    func testObjectRowsUseFieldNamesAndKeepTheRawRow() {
        let raw: [[String: Any]] = [
            ["month": "Jan", "count": 3],
            ["month": "Feb", "count": 7],
        ]
        let rows = data(["data": raw, "x": "month", "y": "count"])
        XCTAssertEqual(rows.map { $0.x }, [.category("Jan"), .category("Feb")])
        XCTAssertEqual(rows.map { $0.y }, [3, 7])
        XCTAssertEqual(
            rows[1].raw,
            .object(["month": .string("Feb"), "count": .number(7)]),
            "the original row travels untouched into the event payload"
        )
    }

    func testBarsSugarNamesTheFields() {
        let rows = data([
            "data": [["day": "Mon", "kcal": 1800]],
            "label": "day",
            "value": "kcal",
        ])
        XCTAssertEqual(rows.map { $0.x }, [.category("Mon")])
        XCTAssertEqual(rows.map { $0.y }, [1800])
    }

    func testObjectRowWithoutAnXFieldFallsBackToTheIndex() {
        let rows = data(["data": [["y": 5], ["y": 6]]])
        XCTAssertEqual(rows.map { $0.x }, [.number(0), .number(1)])
    }

    func testJsonEncodedListIsAccepted() {
        XCTAssertEqual(data(["points": "[[1,2],[3,4]]"]).count, 2)
    }

    func testRowsWithoutAUsableYAreDroppedNotZeroed() {
        let rows = data(["points": [1, NSNull(), "x", 4]])
        XCTAssertEqual(rows.map { $0.index }, [0, 3], "indices stay tied to the bound array")
        XCTAssertEqual(rows.map { $0.y }, [1, 4])
    }

    func testNumericStringsAreNumbersNotCategories() {
        XCTAssertEqual(data(["points": [["x": "5", "y": 1]]]).first?.x, .number(5))
    }

    func testValuesPropAndPositionalArgumentAreBothAccepted() {
        XCTAssertEqual(data(["values": [1, 2, 3]]).count, 3)
        XCTAssertEqual(data(["0": [1, 2]]).count, 2)
    }

    func testHighlightAcceptsAnIndexAListOrNothing() {
        XCTAssertEqual(ChartData.highlightSet(.number(1)), [1])
        XCTAssertEqual(ChartData.highlightSet(.array([.number(0), .number(2)])), [0, 2])
        XCTAssertNil(ChartData.highlightSet(nil))
        XCTAssertNil(ChartData.highlightSet(.null))
        XCTAssertNil(ChartData.highlightSet(.string("")))
    }

    func testAxisPositionalArgumentPicksTheAxis() {
        XCTAssertEqual(ChartData.axisKind(props(["0": "y"])), .y)
        XCTAssertEqual(ChartData.axisKind(props(["axis": "y"])), .y)
        XCTAssertEqual(ChartData.axisKind(props(["0": "x"])), .x)
        XCTAssertEqual(ChartData.axisKind(props([:])), .x)
    }

    /// The payload crosses `JSONSerialization`, so whole numbers must stay
    /// whole: an index must not reach a module handler as `3.0`.
    func testWholeNumbersRoundTripAsIntegers() {
        XCTAssertEqual(ChartJSON.number(62).anyValue as? Int, 62)
        XCTAssertEqual(ChartJSON.number(6.5).anyValue as? Double, 6.5)
        XCTAssertEqual(ChartJSON.from(true), .bool(true), "a JSON bool is not the number 1")
        XCTAssertEqual(ChartJSON.from(1), .number(1))
    }
}

// MARK: - Domains, insets and ticks

final class ChartDomainTests: XCTestCase {

    func testExplicitRangesOnTheChartWin() {
        let resolved = layout(
            [ChartMarkInput(kind: .line, data: data(["points": [[2, 50]]]))],
            x: (0, 10), y: (0, 100)
        )
        XCTAssertEqual(resolved.x.min, 0)
        XCTAssertEqual(resolved.x.max, 10)
        XCTAssertEqual(resolved.y.min, 0)
        XCTAssertEqual(resolved.y.max, 100)
    }

    func testWithoutRangesTheYDomainIsTheNiceRoundedUnionOfTheMarks() {
        let resolved = layout([
            ChartMarkInput(kind: .line, data: data(["points": [[0, 12], [1, 47]]])),
            ChartMarkInput(kind: .points, data: data(["points": [[0, 63]]])),
        ])
        let nice = ChartMath.niceDomain(12, 63, ChartDefaults.ticks)
        XCTAssertEqual(resolved.x.min, 0)
        XCTAssertEqual(resolved.x.max, 1)
        XCTAssertEqual(resolved.y.min, nice.0)
        XCTAssertEqual(resolved.y.max, nice.1)
        XCTAssertLessThanOrEqual(resolved.y.min, 12)
        XCTAssertGreaterThanOrEqual(resolved.y.max, 63)
    }

    func testBarsAlwaysIncludeZeroSoBarHeightsAreHonest() {
        let resolved = layout([ChartMarkInput(kind: .bars, data: data(["data": [40, 50, 60]]))])
        XCTAssertEqual(resolved.y.min, 0)
    }

    func testAStringXAnywhereSwitchesXToCategoricalBands() {
        let rows = data(["data": [["x": "Jan", "y": 1], ["x": "Feb", "y": 2]]])
        let resolved = layout([ChartMarkInput(kind: .bars, data: rows)])
        XCTAssertEqual(resolved.x.kind, .band)
        XCTAssertEqual(resolved.x.categories, ["Jan", "Feb"], "first-seen order")
    }

    func testRuleAndMarkerCoordinatesWidenTheDomain() {
        let resolved = layout([
            ChartMarkInput(kind: .line, data: data(["points": [[0, 1], [1, 2]]])),
            ChartMarkInput(kind: .rule, refY: 90),
        ])
        XCTAssertGreaterThanOrEqual(resolved.y.max, 90)
    }

    func testADegenerateDomainIsPadded() {
        let resolved = layout([ChartMarkInput(kind: .line, data: data(["points": [[5, 7]]]))])
        XCTAssertEqual(resolved.x.min, 4)
        XCTAssertEqual(resolved.x.max, 6)
        XCTAssertLessThan(resolved.y.min, resolved.y.max)
    }

    func testABareChartIsEdgeToEdgeAndAxesReserveLabelRoom() {
        let bare = layout([ChartMarkInput(kind: .line, data: data(["points": [1, 2]]))])
        XCTAssertEqual(bare.plot.minX, ChartDefaults.bareInset)
        XCTAssertEqual(bare.plot.minY, ChartDefaults.bareInset)

        let axes = layout([
            ChartMarkInput(kind: .axis, axis: .x),
            ChartMarkInput(kind: .axis, axis: .y),
            ChartMarkInput(kind: .line, data: data(["points": [1, 2]])),
        ])
        XCTAssertEqual(axes.plot.minX, ChartDefaults.insetLeft)
        XCTAssertEqual(axes.plot.maxY, ChartDefaults.height - ChartDefaults.insetBottom)
        XCTAssertEqual(axes.plot.minY, ChartDefaults.insetTop)
    }

    func testOnlyTheAxesPresentReserveRoom() {
        let yOnly = layout([
            ChartMarkInput(kind: .axis, axis: .y),
            ChartMarkInput(kind: .line, data: data(["points": [1, 2]])),
        ])
        XCTAssertEqual(yOnly.plot.minX, ChartDefaults.insetLeft)
        XCTAssertEqual(
            yOnly.plot.maxY, ChartDefaults.height - ChartDefaults.bareInset,
            "no x axis means no room for x labels"
        )
    }

    func testPaddingPropOverridesEveryInset() {
        let resolved = layout([ChartMarkInput(kind: .axis, axis: .x)], padding: 12)
        XCTAssertEqual(resolved.plot.minX, 12)
        XCTAssertEqual(resolved.plot.minY, 12)
        XCTAssertEqual(resolved.plot.maxX, ChartDefaults.width - 12)
        XCTAssertEqual(resolved.plot.maxY, ChartDefaults.height - 12)
    }

    func testNiceTicks() {
        XCTAssertEqual(ChartMath.ticks(0, 100, 5), [0, 20, 40, 60, 80, 100])
        XCTAssertEqual(ChartMath.ticks(0, 7, 5), [0, 1, 2, 3, 4, 5, 6, 7])
        let nice = ChartMath.niceDomain(12, 63, 5)
        XCTAssertEqual(nice.0, 10)
        XCTAssertEqual(nice.1, 70)
    }

    func testNiceStepThresholds() {
        // normalised step < 1.5 → 1, < 3 → 2, < 7 → 5, else 10.
        XCTAssertEqual(ChartMath.niceStep(0, 5, 5), 1)
        XCTAssertEqual(ChartMath.niceStep(0, 10, 5), 2)
        XCTAssertEqual(ChartMath.niceStep(0, 25, 5), 5)
        XCTAssertEqual(ChartMath.niceStep(0, 40, 5), 10)
    }

    func testTickLabelsDropTrailingNoise() {
        XCTAssertEqual(ChartMath.formatTick(0), "0")
        XCTAssertEqual(ChartMath.formatTick(50), "50")
        XCTAssertEqual(ChartMath.formatTick(0.5), "0.5")
        XCTAssertEqual(ChartMath.formatTick(-2.25), "-2.25")
    }
}

// MARK: - Scales

final class ChartScaleTests: XCTestCase {

    func testLinearScaleMapsAndInverts() {
        let scale = ChartScale.makeLinear(min: 0, max: 100, range: (0, 200))
        XCTAssertEqual(scale.map(50) ?? 0, 100, accuracy: 0.0001)
        XCTAssertEqual(scale.invert(100), 50, accuracy: 0.0001)
    }

    func testYScaleRunsBottomToTop() {
        let resolved = layout(
            [ChartMarkInput(kind: .line, data: data(["points": [[0, 0]]]))], y: (0, 10)
        )
        XCTAssertEqual(resolved.y.map(0) ?? 0, plotBottom, accuracy: 0.0001)
        XCTAssertEqual(resolved.y.map(10) ?? 0, plotTop, accuracy: 0.0001)
    }

    func testBandScaleCentresCategoriesAndRejectsUnknownOnes() {
        let scale = ChartScale.makeBand(categories: ["Jan", "Feb", "Mar"], range: (0, 300))
        XCTAssertEqual(scale.band, 100)
        XCTAssertEqual(scale.map(ChartX.category("Jan")) ?? -1, 50, accuracy: 0.0001)
        XCTAssertEqual(scale.map(ChartX.category("Mar")) ?? -1, 250, accuracy: 0.0001)
        XCTAssertNil(scale.map(ChartX.category("Nope")))
        XCTAssertEqual(scale.category(at: 150), "Feb")
        XCTAssertEqual(scale.category(at: -50), "Jan", "clamped to the ends")
        XCTAssertEqual(scale.category(at: 9999), "Mar")
    }
}

// MARK: - Mark geometry

final class ChartMarkGeometryTests: XCTestCase {

    func testBarsSitOnTheZeroLineWithHeightsProportionalToValue() {
        let rows = data(["data": [25, 100]])
        let resolved = layout([ChartMarkInput(kind: .bars, data: rows)], y: (0, 100))
        let bars = ChartGeometry.bars(
            ChartGeometry.project(rows, layout: resolved),
            layout: resolved,
            ratio: ChartDefaults.barWidth
        )
        XCTAssertEqual(bars.count, 2)
        XCTAssertEqual(bars.map { $0.index }, [0, 1])

        let plotHeight = plotBottom - plotTop
        XCTAssertEqual(bars[1].rect.height, plotHeight, accuracy: 0.1)
        XCTAssertEqual(bars[0].rect.height, plotHeight / 4, accuracy: 0.1)
        XCTAssertEqual(bars[0].rect.maxY, plotBottom, accuracy: 0.1)
    }

    func testBarWidthIsARatioOfTheStepAndIsCentredOnX() {
        let rows = data(["data": [1, 1]])
        let resolved = layout([ChartMarkInput(kind: .bars, data: rows)])
        let projected = ChartGeometry.project(rows, layout: resolved)
        let step = ChartGeometry.barStep(layout: resolved, count: projected.count)
        let bars = ChartGeometry.bars(projected, layout: resolved, ratio: 0.5)
        XCTAssertEqual(bars[0].rect.width, step * 0.5, accuracy: 0.0001)
        XCTAssertEqual(bars[0].rect.midX, projected[0].position.x, accuracy: 0.0001)
    }

    func testCategoricalBarsUseTheBandStep() {
        let rows = data(["data": [["x": "Jan", "y": 1], ["x": "Feb", "y": 2]]])
        let resolved = layout([ChartMarkInput(kind: .bars, data: rows)])
        XCTAssertEqual(
            ChartGeometry.barStep(layout: resolved, count: 2), resolved.x.band, accuracy: 0.0001
        )
    }

    func testLineVerticesProjectOntoThePlot() {
        let rows = data(["points": [0, 10, 5]])
        let resolved = layout([ChartMarkInput(kind: .line, data: rows)], x: (0, 2), y: (0, 10))
        let points = ChartGeometry.project(rows, layout: resolved)
        XCTAssertEqual(points.count, 3)
        XCTAssertEqual(points[0].position.x, plotLeft, accuracy: 0.0001)
        XCTAssertEqual(points[0].position.y, plotBottom, accuracy: 0.0001)
        XCTAssertEqual(points[1].position.y, plotTop, accuracy: 0.0001, "y = 10 is the top")
        XCTAssertEqual(points[2].position.x, plotRight, accuracy: 0.0001)
        XCTAssertEqual(
            points[2].position.y, (plotTop + plotBottom) / 2, accuracy: 0.0001,
            "y = 5 is mid-plot"
        )
    }

    func testSmoothEmitsOneCubicPerSpanAndPassesThroughEveryVertex() {
        let points = [
            CGPoint(x: 0, y: 0), CGPoint(x: 10, y: 20),
            CGPoint(x: 20, y: 10), CGPoint(x: 30, y: 30),
        ]
        let segments = ChartGeometry.smoothSegments(points)
        XCTAssertEqual(segments.count, 3)
        XCTAssertEqual(segments.map { $0.end }, Array(points.dropFirst()))
        // Fewer than three points is a straight polyline, not a curve.
        XCTAssertTrue(ChartGeometry.smoothSegments(Array(points.prefix(2))).isEmpty)
    }

    func testAreaClosesBackDownToTheZeroLine() {
        let rows = data(["points": [5, 10]])
        let resolved = layout([ChartMarkInput(kind: .area, data: rows)], x: (0, 1), y: (0, 10))
        XCTAssertEqual(resolved.zeroY, plotBottom, accuracy: 0.0001)
    }

    func testTheZeroLineIsClampedIntoTheYDomain() {
        let rows = data(["points": [50, 60]])
        let resolved = layout([ChartMarkInput(kind: .area, data: rows)], y: (40, 60))
        XCTAssertEqual(
            resolved.zeroY, plotBottom, accuracy: 0.0001,
            "zero below the domain clamps to the domain minimum"
        )
    }

    func testAxisXLabelsEveryCategoryAndAxisYLabelsNiceTicks() {
        let rows = data(["data": [["x": "Jan", "y": 10], ["x": "Feb", "y": 90]]])
        let resolved = layout(
            [
                ChartMarkInput(kind: .axis, axis: .x),
                ChartMarkInput(kind: .axis, axis: .y),
                ChartMarkInput(kind: .bars, data: rows),
            ],
            y: (0, 100)
        )
        XCTAssertEqual(
            ChartGeometry.axisTicks(.x, layout: resolved, count: ChartDefaults.ticks)
                .map { $0.text },
            ["Jan", "Feb"]
        )
        XCTAssertEqual(
            ChartGeometry.axisTicks(.y, layout: resolved, count: 2).map { $0.text },
            ["0", "50", "100"]
        )
    }

    func testPathIsDrawnInDataUnitsThroughOneAffineTransform() {
        let resolved = layout([ChartMarkInput(kind: .path)], x: (0, 10), y: (0, 10))
        let transform = ChartGeometry.pathTransform(layout: resolved)
        let sx = (plotRight - plotLeft) / 10
        let sy = (plotTop - plotBottom) / 10
        XCTAssertEqual(transform.a, sx, accuracy: 0.0001)
        XCTAssertEqual(transform.d, sy, accuracy: 0.0001)
        XCTAssertEqual(transform.tx, plotLeft, accuracy: 0.0001)
        XCTAssertEqual(transform.ty, plotBottom, accuracy: 0.0001)
        XCTAssertEqual(transform.b, 0)
        XCTAssertEqual(transform.c, 0)

        // A data-unit point lands where the scales say it should.
        let mapped = CGPoint(x: 10, y: 10).applying(transform)
        XCTAssertEqual(mapped.x, plotRight, accuracy: 0.0001)
        XCTAssertEqual(mapped.y, plotTop, accuracy: 0.0001)
    }
}

// MARK: - Highlight

final class ChartHighlightTests: XCTestCase {

    func testHighlightKeepsTheChosenRowsAndDimsTheRest() {
        var mark = ChartMarkSpec(
            id: "b",
            kind: .bars,
            series: "bars",
            data: data(["data": [1, 2, 3]]),
            style: ChartMarkStyle.defaults(for: .bars),
            events: ChartMarkEvents()
        )
        mark.highlight = ChartData.highlightSet(.number(1))

        XCTAssertFalse(mark.isDimmed(1))
        XCTAssertTrue(mark.isDimmed(0))
        XCTAssertTrue(mark.isDimmed(2))
        XCTAssertEqual(ChartDefaults.dimmedOpacity, 0.45)
    }

    func testNoHighlightDimsNothing() {
        let mark = ChartMarkSpec(
            id: "b",
            kind: .bars,
            series: "bars",
            data: data(["data": [1, 2, 3]]),
            style: ChartMarkStyle.defaults(for: .bars),
            events: ChartMarkEvents()
        )
        XCTAssertFalse(mark.isDimmed(0))
        XCTAssertFalse(mark.isDimmed(2))
    }
}

// MARK: - Interaction

final class ChartPayloadTests: XCTestCase {

    private let rows: [[String: Any]] = [
        ["month": "Jan", "count": 10],
        ["month": "Feb", "count": 30],
        ["month": "Mar", "count": 20],
    ]

    private func barsFixture() -> (data: [ChartDatum], layout: ChartLayout) {
        let normalised = data(["data": rows, "x": "month", "y": "count"])
        return (
            data: normalised,
            layout: layout([ChartMarkInput(kind: .bars, data: normalised)])
        )
    }

    func testTappingABarResolvesThatRow() {
        let fixture = barsFixture()
        // The middle band's centre, well inside the bar.
        let centre = fixture.layout.x.map(ChartX.category("Feb")) ?? 0
        let payload = ChartHitTest.markPayload(
            series: "units",
            kind: .bars,
            data: fixture.data,
            layout: fixture.layout,
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: CGPoint(x: centre, y: 150)
        )
        XCTAssertEqual(payload.series, "units")
        XCTAssertEqual(payload.index, 1)
        XCTAssertEqual(payload.x, .category("Feb"))
        XCTAssertEqual(payload.y, 30)
        XCTAssertEqual(
            payload.datum, .object(["month": .string("Feb"), "count": .number(30)])
        )
    }

    func testThePayloadDictionaryIsTheCrossRendererShape() {
        let fixture = barsFixture()
        let centre = fixture.layout.x.map(ChartX.category("Feb")) ?? 0
        let dictionary = ChartHitTest.markPayload(
            series: "units",
            kind: .bars,
            data: fixture.data,
            layout: fixture.layout,
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: CGPoint(x: centre, y: 150)
        ).dictionary

        XCTAssertEqual(dictionary["series"] as? String, "units")
        XCTAssertEqual(dictionary["index"] as? Int, 1)
        XCTAssertEqual(dictionary["x"] as? String, "Feb")
        XCTAssertEqual(dictionary["y"] as? Int, 30)
        XCTAssertEqual((dictionary["datum"] as? [String: Any])?["month"] as? String, "Feb")
        XCTAssertTrue(
            JSONSerialization.isValidJSONObject(dictionary),
            "the payload crosses the action dispatcher as JSON"
        )
    }

    func testAHitOnTheLineItselfResolvesTheDatumNearestThePointer() {
        let normalised = data(["points": [1, 5, 9]])
        let resolved = layout(
            [ChartMarkInput(kind: .line, data: normalised)], x: (0, 2), y: (0, 10)
        )
        // Just right of the middle vertex, but far from every vertex.
        let payload = ChartHitTest.markPayload(
            series: "line",
            kind: .line,
            data: normalised,
            layout: resolved,
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: CGPoint(x: (plotLeft + plotRight) / 2 + 10, y: plotTop)
        )
        XCTAssertEqual(payload.series, "line")
        XCTAssertEqual(payload.index, 1)
        XCTAssertEqual(payload.x, .number(1))
        XCTAssertEqual(payload.y, 5)
    }

    func testAPointerPastTheLastVertexClampsToTheLastDatum() {
        let normalised = data(["points": [1, 5, 9]])
        let resolved = layout([ChartMarkInput(kind: .line, data: normalised)], x: (0, 2))
        let payload = ChartHitTest.markPayload(
            series: "line",
            kind: .line,
            data: normalised,
            layout: resolved,
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: CGPoint(x: 9999, y: 0)
        )
        XCTAssertEqual(payload.index, 2)
    }

    func testAVertexWithinTheTouchRadiusWinsOverNearestX() {
        let normalised = data(["points": [1, 5, 9]])
        let resolved = layout(
            [ChartMarkInput(kind: .line, data: normalised)], x: (0, 2), y: (0, 10)
        )
        let vertex = ChartGeometry.project(normalised, layout: resolved)[2]
        let index = ChartHitTest.directHit(
            kind: .line,
            data: normalised,
            layout: resolved,
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: CGPoint(x: vertex.position.x - 4, y: vertex.position.y - 4)
        )
        XCTAssertEqual(index, 2)
        XCTAssertEqual(ChartDefaults.hitRadius, 12, "fingers need a 12pt target")
    }

    func testAMarkWithNoDataEventResolvesToTheSeriesOnly() {
        let payload = ChartHitTest.markPayload(
            series: "revenue",
            kind: .line,
            data: [],
            layout: layout([]),
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: CGPoint(x: 100, y: 100)
        )
        XCTAssertEqual(payload.series, "revenue")
        XCTAssertNil(payload.index)
        XCTAssertNil(payload.datum)
        XCTAssertEqual(payload.dictionary.count, 1)
    }

    func testAnEventWithoutAPointerStillNamesTheSeries() {
        let normalised = data(["points": [1, 2]])
        let payload = ChartHitTest.markPayload(
            series: "line",
            kind: .line,
            data: normalised,
            layout: layout([ChartMarkInput(kind: .line, data: normalised)]),
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: nil
        )
        XCTAssertEqual(payload.series, "line")
        XCTAssertNil(payload.index)
    }

    func testANonDataMarkResolvesToTheSeriesOnly() {
        let payload = ChartHitTest.markPayload(
            series: "rule",
            kind: .rule,
            data: [],
            layout: layout([ChartMarkInput(kind: .rule, refY: 5)]),
            barRatio: ChartDefaults.barWidth,
            pointRadius: ChartDefaults.pointRadius,
            point: CGPoint(x: 100, y: 100)
        )
        XCTAssertEqual(payload.series, "rule")
        XCTAssertNil(payload.index)
    }

    func testChartLevelEventsResolveThePointerToDataCoordinates() {
        let normalised = data(["points": [[0, 0]]])
        let resolved = layout(
            [ChartMarkInput(kind: .line, data: normalised)], x: (0, 100), y: (0, 10)
        )
        let payload = ChartHitTest.chartPayload(
            layout: resolved,
            point: CGPoint(x: (plotLeft + plotRight) / 2, y: plotTop)
        )
        XCTAssertEqual(payload.x.numberValue ?? .nan, 50, accuracy: 0.0001)
        XCTAssertEqual(payload.y, 10, accuracy: 0.0001)
    }

    func testChartLevelEventsOnABandScaleCarryTheCategory() {
        let fixture = barsFixture()
        let centre = fixture.layout.x.map(ChartX.category("Mar")) ?? 0
        let payload = ChartHitTest.chartPayload(
            layout: fixture.layout, point: CGPoint(x: centre, y: 100)
        )
        XCTAssertEqual(payload.x, .category("Mar"))
    }
}

// MARK: - Marker

final class ChartMarkerTests: XCTestCase {

    private func markerLayout() -> ChartLayout {
        layout([ChartMarkInput(kind: .line, data: data(["points": [1]]))], x: (0, 10), y: (0, 10))
    }

    func testMarkerSitsAtTheDataCoordinateAndKeepsItsAnchor() {
        let placement = ChartGeometry.markerPlacement(
            x: .number(10), y: 10, anchor: .left, layout: markerLayout()
        )
        XCTAssertEqual(placement?.point.x ?? .nan, plotRight, accuracy: 0.0001)
        XCTAssertEqual(placement?.point.y ?? .nan, plotTop, accuracy: 0.0001)
        XCTAssertEqual(placement?.anchor, .left)
    }

    func testMarkerWithNoCoordinatesIsHidden() {
        XCTAssertNil(
            ChartGeometry.markerPlacement(x: nil, y: nil, anchor: .top, layout: markerLayout()),
            "a tooltip bound to a null state value simply disappears"
        )
    }

    func testOneCoordinateCentresTheOtherAxis() {
        let placement = ChartGeometry.markerPlacement(
            x: nil, y: 5, anchor: .top, layout: markerLayout()
        )
        XCTAssertEqual(placement?.point.x ?? .nan, (plotLeft + plotRight) / 2, accuracy: 0.0001)
        XCTAssertEqual(placement?.point.y ?? .nan, (plotTop + plotBottom) / 2, accuracy: 0.0001)
    }

    func testAnUnknownCategoryHidesTheMarker() {
        let rows = data(["data": [["x": "Jan", "y": 1]]])
        let resolved = layout([ChartMarkInput(kind: .bars, data: rows)])
        XCTAssertNil(
            ChartGeometry.markerPlacement(
                x: .category("Nope"), y: 1, anchor: .top, layout: resolved
            )
        )
    }

    func testAnchorDefaultsToTop() {
        XCTAssertEqual(ChartMarkerAnchor.named(nil), .top)
        XCTAssertEqual(ChartMarkerAnchor.named("nonsense"), .top)
        XCTAssertEqual(ChartMarkerAnchor.named("BOTTOM"), .bottom)
        XCTAssertEqual(ChartMarkerAnchor.named("center"), .center)
        XCTAssertEqual(ChartDefaults.markerGap, 8)
    }
}

// MARK: - Mark styling defaults

final class ChartMarkStyleTests: XCTestCase {

    func testPerMarkPresentationDefaults() {
        let line = ChartMarkStyle.defaults(for: .line)
        XCTAssertTrue(line.fillNone)
        XCTAssertEqual(line.strokeWidth, 2)

        let area = ChartMarkStyle.defaults(for: .area)
        XCTAssertTrue(area.strokeNone)
        XCTAssertEqual(area.fillOpacity, 0.15)

        let axis = ChartMarkStyle.defaults(for: .axis)
        XCTAssertEqual(axis.strokeWidth, 1)
        XCTAssertEqual(axis.strokeOpacity, 0.5)
        XCTAssertEqual(axis.fillOpacity, 0.75)

        let rule = ChartMarkStyle.defaults(for: .rule)
        XCTAssertEqual(rule.dash, [4, 4])
        XCTAssertEqual(rule.strokeOpacity, 0.7)

        XCTAssertTrue(ChartMarkStyle.defaults(for: .bars).strokeNone)
        XCTAssertTrue(ChartMarkStyle.defaults(for: .points).strokeNone)
        XCTAssertEqual(ChartMarkStyle.defaults(for: .path).strokeWidth, 2)
    }

    /// With nothing declared, geometry paints with the inherited text colour
    /// (`.foreground`), so `.color()` on the Chart or an ancestor flows in.
    func testUndeclaredPaintFallsBackToTheInheritedColour() {
        let style = ChartMarkStyle.defaults(for: .line)
        XCTAssertNil(style.stroke)
        XCTAssertNil(style.tint)
        XCTAssertNotNil(style.strokeShading)
        XCTAssertNil(style.fillShading, "a Line has no fill")
    }

    func testStrokeAndFillApplicatorsAreRead() {
        let style = ChartProps.style(
            kind: .line,
            props: ChartProps.lowercased([
                "stroke.0": "#3b82f6",
                "strokeWidth.0": 3,
                "strokeOpacity.0": 0.5,
                "strokeDasharray.0": "2 6",
            ]),
            tint: .primary
        )
        XCTAssertNotNil(style.stroke)
        XCTAssertEqual(style.strokeWidth, 3)
        XCTAssertEqual(style.strokeOpacity, 0.5)
        XCTAssertEqual(style.dash, [2, 6])
    }

    func testStrokeNoneClearsTheChannel() {
        let style = ChartProps.style(
            kind: .line, props: ChartProps.lowercased(["stroke.0": "none"]), tint: .primary
        )
        XCTAssertTrue(style.strokeNone)
        XCTAssertNil(style.strokeShading)
    }

    func testNamedEffectArgumentsFromEnginePatches() {
        let glow = ChartProps.style(kind: .line, props: ["glow.color": "#d6fc74", "glow.radius": 4], tint: .primary)
        XCTAssertEqual(glow.shadow?.radius, 4)
        XCTAssertEqual(glow.shadow?.color, ColorParser.parse("#d6fc74"))
        let shadow = ChartProps.style(kind: .line, props: ["shadow.color": "#000000", "shadow.blur": 8, "shadow.y": 2], tint: .primary)
        XCTAssertEqual(shadow.shadow?.radius, 8)
        XCTAssertEqual(shadow.shadow?.dy, 2)
    }

    func testGlowDefaultsToSixPointsInTheTextColour() {
        let radiusOnly = ChartProps.style(
            kind: .line, props: ChartProps.lowercased(["glow.0": "#10b981"]), tint: .primary
        )
        XCTAssertEqual(radiusOnly.shadow?.radius, ChartDefaults.glowRadius)
        XCTAssertEqual(radiusOnly.shadow?.dx, 0)
        XCTAssertEqual(radiusOnly.shadow?.dy, 0)

        let sized = ChartProps.style(
            kind: .line, props: ChartProps.lowercased(["glow.0": 12]), tint: .primary
        )
        XCTAssertEqual(sized.shadow?.radius, 12)

        let both = ChartProps.style(
            kind: .line,
            props: ChartProps.lowercased(["glow.0": ["color": "gold", "radius": 10]]),
            tint: .primary
        )
        XCTAssertEqual(both.shadow?.radius, 10)
    }

    func testShadowFamilyBecomesAShapeShadow() {
        let shadow = ChartProps.style(
            kind: .line,
            props: ChartProps.lowercased(["shadow.0": ["y": 2, "blur": 8, "color": "#000"]]),
            tint: .primary
        )
        XCTAssertEqual(shadow.shadow?.radius, 8)
        XCTAssertEqual(shadow.shadow?.dy, 2)

        let elevation = ChartProps.style(
            kind: .points, props: ChartProps.lowercased(["elevation.0": 2]), tint: .primary
        )
        XCTAssertNotNil(elevation.shadow)
        XCTAssertEqual(elevation.shadow?.dy, 2)
    }

    func testEventApplicatorsCarryTheirStaticArguments() {
        let events = ChartProps.events(
            ChartProps.lowercased(["onClick.0": "@actions.pick", "onClick.tag": "targets"])
        )
        XCTAssertEqual(events.click?.actionName, "pick")
        XCTAssertEqual(events.click?.payload["tag"] as? String, "targets")
        XCTAssertTrue(events.isInteractive)
    }

    func testAMarkWithoutEventApplicatorsIsNotInteractive() {
        let events = ChartProps.events(ChartProps.lowercased(["points": [1, 2]]))
        XCTAssertFalse(
            events.isInteractive,
            "decorative marks must stay pointer-transparent"
        )
    }

    func testOnMoveAndOnMouseLeaveAreRecognised() {
        let events = ChartProps.events(
            ChartProps.lowercased([
                "onMove.0": "@actions.track",
                "onMouseLeave.0": "@actions.clearHover",
                "onLongPress.0": "@actions.details",
                "onHover.0": "@actions.hover",
            ])
        )
        XCTAssertEqual(events.move?.actionName, "track")
        XCTAssertEqual(events.leave?.actionName, "clearHover")
        XCTAssertEqual(events.longPress?.actionName, "details")
        XCTAssertEqual(events.hover?.actionName, "hover")
        XCTAssertEqual(ChartDefaults.longPressDuration, 0.5)
    }
}

// MARK: - Gesture bookkeeping

final class ChartGestureTrackerTests: XCTestCase {

    func testMoveIsThrottledToRoughlyOneFrame() {
        let tracker = ChartGestureTracker()
        XCTAssertTrue(tracker.shouldEmitMove(now: 100))
        XCTAssertFalse(tracker.shouldEmitMove(now: 100 + ChartDefaults.moveThrottle / 2))
        XCTAssertTrue(tracker.shouldEmitMove(now: 100 + ChartDefaults.moveThrottle * 2))
    }
}

import Testing
import SwiftUI
@testable import HypenSwift

// MARK: - ColorParser Tests

@Test func testColorParserNamedColors() {
    #expect(ColorParser.parse("red") != nil)
    #expect(ColorParser.parse("blue") != nil)
    #expect(ColorParser.parse("green") != nil)
    #expect(ColorParser.parse("white") != nil)
    #expect(ColorParser.parse("black") != nil)
}

@Test func testColorParserNamedColorsCaseInsensitive() {
    #expect(ColorParser.parse("RED") != nil)
    #expect(ColorParser.parse("Blue") != nil)
    #expect(ColorParser.parse("GREEN") != nil)
}

@Test func testColorParserTransparent() {
    let color = ColorParser.parse("transparent")
    #expect(color != nil)
}

@Test func testColorParserHex6Digit() {
    let color = ColorParser.parse("#FF0000")
    #expect(color != nil)
}

@Test func testColorParserHex3Digit() {
    let color = ColorParser.parse("#F00")
    #expect(color != nil)
}

@Test func testColorParserHex8DigitWithAlpha() {
    let color = ColorParser.parse("#FF000080")
    #expect(color != nil)
}

@Test func testColorParserHexWithoutHash() {
    let color = ColorParser.parse("00FF00")
    #expect(color != nil)
}

@Test func testColorParserRGB() {
    let color = ColorParser.parse("rgb(255, 0, 0)")
    #expect(color != nil)
}

@Test func testColorParserRGBA() {
    let color = ColorParser.parse("rgba(255, 0, 0, 0.5)")
    #expect(color != nil)
}

@Test func testColorParserHSL() {
    let color = ColorParser.parse("hsl(120, 50, 50)")
    #expect(color != nil)
}

@Test func testColorParserDictionaryShortKeys() {
    let color = ColorParser.parse([
        "r": 255.0,
        "g": 0.0,
        "b": 0.0
    ] as [String: Any])
    #expect(color != nil)
}

@Test func testColorParserDictionaryLongKeys() {
    let color = ColorParser.parse([
        "red": 255.0,
        "green": 0.0,
        "blue": 0.0,
        "alpha": 0.5
    ] as [String: Any])
    #expect(color != nil)
}

@Test func testColorParserArrayFormat() {
    let color = ColorParser.parse([255, 0, 0] as [Any])
    #expect(color != nil)
}

@Test func testColorParserArrayFormatWithAlpha() {
    let color = ColorParser.parse([255, 0, 0, 128] as [Any])
    #expect(color != nil)
}

@Test func testColorParserNilInput() {
    let color = ColorParser.parse(nil)
    #expect(color == nil)
}

@Test func testColorParserInvalidString() {
    let color = ColorParser.parse("notacolor")
    #expect(color == nil)
}

@Test func testColorParserCSSNamedColors() {
    #expect(ColorParser.parse("cornflowerblue") != nil)
    #expect(ColorParser.parse("darkslategray") != nil)
    #expect(ColorParser.parse("salmon") != nil)
    #expect(ColorParser.parse("tomato") != nil)
}

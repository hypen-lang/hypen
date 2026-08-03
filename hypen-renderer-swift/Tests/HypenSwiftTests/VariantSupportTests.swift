import Testing
import SwiftUI
@testable import HypenSwift

// MARK: - Breakpoint Tests

@Test func testBreakpointMinWidthValues() {
    #expect(Breakpoint.sm.minWidth == 640)
    #expect(Breakpoint.md.minWidth == 768)
    #expect(Breakpoint.lg.minWidth == 1024)
    #expect(Breakpoint.xl.minWidth == 1280)
    #expect(Breakpoint.xxl.minWidth == 1536)
}

@Test func testBreakpointFromString() {
    #expect(Breakpoint.from("sm") == .sm)
    #expect(Breakpoint.from("md") == .md)
    #expect(Breakpoint.from("lg") == .lg)
    #expect(Breakpoint.from("xl") == .xl)
    #expect(Breakpoint.from("2xl") == .xxl)
}

@Test func testBreakpointFromStringCaseInsensitive() {
    #expect(Breakpoint.from("SM") == .sm)
    #expect(Breakpoint.from("MD") == .md)
    #expect(Breakpoint.from("Lg") == .lg)
}

@Test func testBreakpointFromInvalidString() {
    #expect(Breakpoint.from("invalid") == nil)
    #expect(Breakpoint.from("xs") == nil)
    #expect(Breakpoint.from("") == nil)
}

@Test func testBreakpointComparable() {
    #expect(Breakpoint.sm < Breakpoint.md)
    #expect(Breakpoint.md < Breakpoint.lg)
    #expect(Breakpoint.lg < Breakpoint.xl)
    #expect(Breakpoint.xl < Breakpoint.xxl)
}

// MARK: - StateVariant Tests

@Test func testStateVariantFromString() {
    #expect(StateVariant.from("hover") == .hover)
    #expect(StateVariant.from("focus") == .focus)
    #expect(StateVariant.from("active") == .active)
    #expect(StateVariant.from("disabled") == .disabled)
    #expect(StateVariant.from("focus-visible") == .focusVisible)
    #expect(StateVariant.from("focus-within") == .focusWithin)
}

@Test func testStateVariantFromStringCaseInsensitive() {
    #expect(StateVariant.from("HOVER") == .hover)
    #expect(StateVariant.from("Focus") == .focus)
    #expect(StateVariant.from("ACTIVE") == .active)
}

@Test func testStateVariantFromInvalidString() {
    #expect(StateVariant.from("invalid") == nil)
    #expect(StateVariant.from("click") == nil)
    #expect(StateVariant.from("") == nil)
}

// MARK: - parseVariantName Tests

@Test func testParseVariantNameBasic() {
    let result = parseVariantName("padding")

    #expect(result.baseName == "padding")
    #expect(result.breakpoint == nil)
    #expect(result.state == nil)
    #expect(result.isVariant == false)
    #expect(result.isResponsive == false)
    #expect(result.isStateful == false)
}

@Test func testParseVariantNameResponsive() {
    let smResult = parseVariantName("padding@sm")
    #expect(smResult.baseName == "padding")
    #expect(smResult.breakpoint == .sm)
    #expect(smResult.state == nil)
    #expect(smResult.isResponsive == true)
    #expect(smResult.isStateful == false)

    let mdResult = parseVariantName("width@md")
    #expect(mdResult.baseName == "width")
    #expect(mdResult.breakpoint == .md)

    let xlResult = parseVariantName("font-size@xl")
    #expect(xlResult.baseName == "font-size")
    #expect(xlResult.breakpoint == .xl)

    let xxlResult = parseVariantName("gap@2xl")
    #expect(xxlResult.baseName == "gap")
    #expect(xxlResult.breakpoint == .xxl)
}

@Test func testParseVariantNameState() {
    let hoverResult = parseVariantName("background-color:hover")
    #expect(hoverResult.baseName == "background-color")
    #expect(hoverResult.breakpoint == nil)
    #expect(hoverResult.state == .hover)
    #expect(hoverResult.isResponsive == false)
    #expect(hoverResult.isStateful == true)

    let focusResult = parseVariantName("border-color:focus")
    #expect(focusResult.baseName == "border-color")
    #expect(focusResult.state == .focus)

    let activeResult = parseVariantName("opacity:active")
    #expect(activeResult.baseName == "opacity")
    #expect(activeResult.state == .active)

    let disabledResult = parseVariantName("color:disabled")
    #expect(disabledResult.baseName == "color")
    #expect(disabledResult.state == .disabled)
}

@Test func testParseVariantNameInvalidBreakpoint() {
    let result = parseVariantName("padding@invalid")

    // An unrecognised marker is left as part of the base name (so it never
    // matches a real applicator), matching the engine + web parsers.
    #expect(result.baseName == "padding@invalid")
    #expect(result.breakpoint == nil) // Invalid breakpoint becomes nil
    #expect(result.state == nil)
}

@Test func testParseVariantNameInvalidState() {
    let result = parseVariantName("padding:invalid")

    #expect(result.baseName == "padding:invalid")
    #expect(result.breakpoint == nil)
    #expect(result.state == nil) // Invalid state becomes nil
}

@Test func testParseVariantNameComplexPropertyNames() {
    let result1 = parseVariantName("background-color@lg")
    #expect(result1.baseName == "background-color")
    #expect(result1.breakpoint == .lg)

    let result2 = parseVariantName("border-top-width:hover")
    #expect(result2.baseName == "border-top-width")
    #expect(result2.state == .hover)
}

@Test func testParseVariantNameCombined() {
    // Combined `@bp:state` must resolve BOTH halves (previously the state was
    // silently dropped). Mirrors the cross-SDK `parse-combined` fixture.
    let result = parseVariantName("backgroundColor@md:hover")
    #expect(result.baseName == "backgroundColor")
    #expect(result.breakpoint == .md)
    #expect(result.state == .hover)
    #expect(result.isVariant)

    let hyphenated = parseVariantName("background-color@2xl:focus-within")
    #expect(hyphenated.baseName == "background-color")
    #expect(hyphenated.breakpoint == .xxl)
    #expect(hyphenated.state == .focusWithin)
}

// MARK: - VariantModifiers Tests

@Test func testVariantModifiersInit() {
    let variants = VariantModifiers()

    #expect(variants.responsive.isEmpty)
    #expect(variants.states.isEmpty)
}

@Test func testVariantModifiersForWidthNoVariants() {
    let variants = VariantModifiers()
    var base = HypenModifier()
    base.setPadding(all: 16)

    let result = variants.modifierForWidth(800, base: base)

    // Should return base modifier unchanged
    #expect(result.paddingTop == 16)
    #expect(result.paddingBottom == 16)
}

@Test func testVariantModifiersForWidthWithResponsiveOverride() {
    var variants = VariantModifiers()
    var base = HypenModifier()
    base.setPadding(all: 16)

    var mdOverride = HypenModifier()
    mdOverride.setPadding(all: 32)
    variants.responsive[.md] = mdOverride

    // Width less than md breakpoint (768) - should use base
    let result1 = variants.modifierForWidth(600, base: base)
    #expect(result1.paddingTop == 16)

    // Width at md breakpoint - should use md override
    let result2 = variants.modifierForWidth(768, base: base)
    #expect(result2.paddingTop == 32)

    // Width above md breakpoint - should use md override
    let result3 = variants.modifierForWidth(900, base: base)
    #expect(result3.paddingTop == 32)
}

@Test func testVariantModifiersForWidthMultipleBreakpoints() {
    var variants = VariantModifiers()
    var base = HypenModifier()
    base.width = 100

    var smOverride = HypenModifier()
    smOverride.width = 200
    variants.responsive[.sm] = smOverride

    var mdOverride = HypenModifier()
    mdOverride.width = 300
    variants.responsive[.md] = mdOverride

    var lgOverride = HypenModifier()
    lgOverride.width = 400
    variants.responsive[.lg] = lgOverride

    // Below sm (640)
    let result1 = variants.modifierForWidth(500, base: base)
    #expect(result1.width == 100)

    // At sm
    let result2 = variants.modifierForWidth(640, base: base)
    #expect(result2.width == 200)

    // At md
    let result3 = variants.modifierForWidth(768, base: base)
    #expect(result3.width == 300)

    // At lg
    let result4 = variants.modifierForWidth(1024, base: base)
    #expect(result4.width == 400)
}

@Test func testVariantModifiersForWidthSelectiveMerge() {
    var variants = VariantModifiers()
    var base = HypenModifier()
    base.width = 100
    base.height = 50
    base.backgroundColor = .blue

    // md override only changes width
    var mdOverride = HypenModifier()
    mdOverride.width = 200
    variants.responsive[.md] = mdOverride

    let result = variants.modifierForWidth(800, base: base)

    // Width should be overridden
    #expect(result.width == 200)
    // Height should remain from base
    #expect(result.height == 50)
    // Background should remain from base
    #expect(result.backgroundColor == .blue)
}

// MARK: - VariantInfo Tests

@Test func testVariantInfoProperties() {
    let basic = VariantInfo(baseName: "padding", breakpoint: nil, state: nil)
    #expect(basic.isVariant == false)
    #expect(basic.isResponsive == false)
    #expect(basic.isStateful == false)

    let responsive = VariantInfo(baseName: "padding", breakpoint: .md, state: nil)
    #expect(responsive.isVariant == true)
    #expect(responsive.isResponsive == true)
    #expect(responsive.isStateful == false)

    let stateful = VariantInfo(baseName: "padding", breakpoint: nil, state: .hover)
    #expect(stateful.isVariant == true)
    #expect(stateful.isResponsive == false)
    #expect(stateful.isStateful == true)
}

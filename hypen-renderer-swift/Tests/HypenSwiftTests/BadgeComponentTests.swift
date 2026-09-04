import SwiftUI
import Testing
@testable import HypenSwift

@MainActor
@Suite("Badge contract")
struct BadgeComponentTests {
    @Test func rawBadgeUsesCanonicalDefaults() {
        let resolution = resolveBadgeModifier(HypenModifier())
        let modifier = resolution.modifier

        #expect(resolution.defaultedBackground)
        #expect(resolution.defaultedForeground)
        #expect(resolution.defaultedCornerRadius)
        #expect(resolution.defaultedPadding)
        #expect(modifier.cornerRadius == 4)
        #expect(modifier.paddingTop == 4)
        #expect(modifier.paddingBottom == 4)
        #expect(modifier.paddingLeading == 8)
        #expect(modifier.paddingTrailing == 8)
        #expect(BadgeDefaults.fontSize == 12)
        #expect(BadgeDefaults.fontWeight == .semibold)
    }

    @Test func customPaddingReplacesRatherThanAddsToDefault() {
        var source = HypenModifier()
        source.setPadding(all: 2)

        let resolution = resolveBadgeModifier(source)

        #expect(!resolution.defaultedPadding)
        #expect(resolution.modifier.paddingTop == 2)
        #expect(resolution.modifier.paddingBottom == 2)
        #expect(resolution.modifier.paddingLeading == 2)
        #expect(resolution.modifier.paddingTrailing == 2)
    }

    @Test func explicitTwentyPointCountBadgeHasNoImplicitPadding() {
        var source = HypenModifier()
        source.width = 20
        source.height = 20

        let resolution = resolveBadgeModifier(source)

        #expect(!resolution.defaultedPadding)
        #expect(resolution.modifier.width == 20)
        #expect(resolution.modifier.height == 20)
        #expect(resolution.modifier.paddingTop == 0)
        #expect(resolution.modifier.paddingLeading == 0)
    }

    @Test func customVisualsWinIncludingExplicitSquareRadius() {
        var source = HypenModifier()
        source.backgroundColor = .red
        source.foregroundColor = .white
        source.cornerRadius = 0
        source.explicitlySetProperties.insert("cornerRadius")
        source.fontSize = 14
        source.fontWeight = .medium

        let resolution = resolveBadgeModifier(source)

        #expect(!resolution.defaultedBackground)
        #expect(!resolution.defaultedForeground)
        #expect(!resolution.defaultedCornerRadius)
        #expect(resolution.modifier.cornerRadius == 0)
        #expect(resolution.modifier.fontSize == 14)
        #expect(resolution.modifier.fontWeight == .medium)
    }
}

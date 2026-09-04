import SwiftUI
import Testing
@testable import HypenSwift

@MainActor
@Suite("Avatar decoration")
struct AvatarComponentTests {
    @Test func borderedFortyPointAvatarKeepsItsMeasurementAndPaintsCircularSeparator() {
        let element = HypenElement(
            id: "avatar-border-test",
            elementType: "avatar",
            props: [
                "width.0": 40,
                "height.0": 40,
                "cornerRadius.0": 20,
                "border.width": 2,
                "border.color": "#ffffff",
            ],
            children: []
        )
        let source = ApplicatorRegistry.withDefaults().applyAllWithVariants(
            element: element,
            context: ApplicatorContext(
                element: element,
                actionDispatcher: MockActionDispatcher()
            )
        ).baseModifier

        let decoration = avatarDecorationModifier(source, size: 40)
        let recipe = avatarRenderRecipe(modifier: decoration, size: 40)

        // The component's own 40x40 frame is the sole layout measurement;
        // border painting is an overlay on that frame.
        #expect(decoration.width == nil)
        #expect(decoration.height == nil)
        #expect(recipe.contentSize == 40)
        #expect(recipe.imageClipRadius == 20)
        #expect(recipe.decorationCornerRadius == 20)
        #expect(recipe.borderWidth == 2)
        #expect(recipe.borderPaint == .solid)
        #expect(recipe.paintsCircularSeparator)
    }

    @Test func noBorderBaselineKeepsCircularClipWithoutSeparatorPaint() {
        var source = HypenModifier()
        source.width = 40
        source.height = 40

        let decoration = avatarDecorationModifier(source, size: 40)
        let recipe = avatarRenderRecipe(modifier: decoration, size: 40)

        #expect(decoration.width == nil)
        #expect(decoration.height == nil)
        #expect(recipe.contentSize == 40)
        #expect(recipe.imageClipRadius == 20)
        #expect(recipe.decorationCornerRadius == 20)
        #expect(recipe.borderPaint == nil)
        #expect(!recipe.paintsCircularSeparator)
    }

    @Test func layoutIsStrippedButVisualEffectsAndMarginsArePreserved() {
        var source = HypenModifier()
        source.width = 40
        source.height = 40
        source.minWidth = 20
        source.maxHeight = 80
        source.fillMaxWidth = true
        source.aspectRatio = 1
        source.setPadding(all: 6)
        source.marginLeading = -12
        source.opacity = 0.6
        source.shadowRadius = 3
        source.blurRadius = 1
        source.rotation = 5

        let decoration = avatarDecorationModifier(source, size: 40)

        #expect(decoration.width == nil)
        #expect(decoration.height == nil)
        #expect(decoration.minWidth == nil)
        #expect(decoration.maxHeight == nil)
        #expect(!decoration.fillMaxWidth)
        #expect(decoration.aspectRatio == nil)
        #expect(decoration.paddingTop == 0)
        #expect(decoration.paddingLeading == 0)
        #expect(decoration.marginLeading == -12)
        #expect(decoration.opacity == 0.6)
        #expect(decoration.shadowRadius == 3)
        #expect(decoration.blurRadius == 1)
        #expect(decoration.rotation == 5)
    }

    @Test func explicitSquareDecorationDoesNotChangeCircularImageClip() {
        var source = HypenModifier()
        source.cornerRadius = 0
        source.explicitlySetProperties.insert("cornerRadius")
        source.borderWidth = 2
        source.borderColor = .white

        let decoration = avatarDecorationModifier(source, size: 40)
        let recipe = avatarRenderRecipe(modifier: decoration, size: 40)

        #expect(recipe.imageClipRadius == 20)
        #expect(recipe.decorationCornerRadius == 0)
        #expect(!recipe.paintsCircularSeparator)
    }
}

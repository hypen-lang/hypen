import SwiftUI

// MARK: - Background Color Applicator

public struct BackgroundColorApplicator: ApplicatorHandler {
    public let name = "backgroundcolor"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.backgroundColor = color
        }
    }
}

// MARK: - Background Applicator (the CSS `background` shorthand)

/// The CSS `background` shorthand.
///
/// This only accepted a flat colour, so a gradient, an image, or a layered
/// combination of both silently vanished. The home-screen example's
/// wallpaper arrives as `linear-gradient(…), url('data:image/png;base64,…')
/// center / cover no-repeat`, which is exactly that case.
///
/// A bare colour still takes the colour path, so `background("#fff")` is
/// unchanged.
public struct BackgroundApplicator: ApplicatorHandler {
    public let name = "background"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        guard let layers = CssBackground.parse(value) else {
            if let color = ColorParser.parse(value) { modifier.backgroundColor = color }
            return
        }

        // The shorthand ALWAYS owns the layer stack — even when it carries
        // nothing but a colour.
        //
        // CSS `background` resets every background longhand it doesn't
        // mention, so a `:hover` or responsive variant declaring
        // `background: red` must REPLACE a base gradient, not sit behind it.
        // Routing the plain-colour case to `backgroundColor` instead left the
        // base `cssBackground` in place, and since rendering prefers
        // `cssBackground` the variant colour never appeared at all.
        modifier.cssBackground = layers
    }
}

// MARK: - Foreground Color Applicator

public struct ForegroundColorApplicator: ApplicatorHandler {
    public let name = "foregroundcolor"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.foregroundColor = color
        }
    }
}

// MARK: - Color Applicator (for text)

public struct ColorApplicator: ApplicatorHandler {
    public let name = "color"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.foregroundColor = color
        }
    }
}

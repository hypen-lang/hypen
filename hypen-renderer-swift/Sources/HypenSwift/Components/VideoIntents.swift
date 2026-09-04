import SwiftUI

// MARK: - Renderer-local video intents

/// `.videoIntent("fullscreen")` — the renderer-local intent channel.
///
/// Normative source: `hypen-web/docs/components/video.md`
/// §"Fullscreen: `videoIntent("fullscreen")` (renderer-local)". Reference
/// implementation: the DOM `videoIntent` applicator handler in
/// `hypen-web/packages/web/src/dom/applicators/events.ts`.
///
/// Three rules the platforms share:
///
/// 1. **Renderer-local.** The tap is handled where it lands — no action, no
///    module, no round trip. (The web needs that to keep transient
///    activation; native needs it because fullscreen is presentation, not
///    application state.)
/// 2. **The target is the video CONTAINER**, never the platform player. The
///    container carries the surface *and* the composition slots, so custom
///    controls stay overlaid in fullscreen. This is why iOS presents the
///    container in a `.fullScreenCover` and never uses
///    `AVPlayerViewController`'s native fullscreen, whose own chrome would
///    replace the author's.
/// 3. **Inert outside a Video subtree.** The intent travels through the
///    `\.videoFullscreen` environment, which only a `Video` publishes —
///    everywhere else the prop does nothing, mirroring the DOM handler
///    finding no video wrapper above the clicked node.
public enum VideoIntent: String, Equatable, Sendable {
    case fullscreen
}

extension VideoIntent {
    /// Parses a raw `videoIntent` prop value.
    ///
    /// Deliberately strict, matching the DOM handler (`typeof value ===
    /// "string"`, then `intent !== "fullscreen"` → bail): a non-string, or
    /// any spelling other than the exact wire name, is not an intent.
    /// Unknown intents are inert rather than errors — the contract promises
    /// the prop can be authored everywhere today and simply does nothing
    /// where a renderer has not implemented it.
    ///
    /// Note it reads `props` directly rather than through
    /// `getStringProp(_:)`, which stringifies non-strings and would turn a
    /// stray number into a "value" to parse.
    public static func parse(_ value: Any?) -> VideoIntent? {
        guard let name = value as? String else { return nil }
        return VideoIntent(rawValue: name)
    }

    /// The raw `videoIntent` prop in either wire spelling: the applicator
    /// lowers `.videoIntent("fullscreen")` to `videoIntent.0`, a plain prop
    /// arrives bare.
    @MainActor
    static func rawProp(_ element: HypenElement) -> Any? {
        element.props["videoIntent.0"] ?? element.props["videoIntent"]
    }

    /// The intent an element carries, if any.
    @MainActor
    static func from(_ element: HypenElement) -> VideoIntent? {
        parse(rawProp(element))
    }
}

// MARK: - Fullscreen toggle

/// The fullscreen presentation state machine — pure, so the whole rule set
/// is testable without a player or a window.
public enum VideoFullscreenPresentation {
    /// `fullscreen` is a pure toggle: the same intent button enters and
    /// leaves, so there is always a way back even when the author ships no
    /// other chrome. `insideVideo` is the inertness rule — an intent raised
    /// outside a Video subtree changes nothing.
    public static func next(
        current: Bool,
        intent: VideoIntent?,
        insideVideo: Bool
    ) -> Bool {
        guard insideVideo, let intent = intent else { return current }
        switch intent {
        case .fullscreen:
            return !current
        }
    }
}

/// The enclosing Video's fullscreen presentation, published to its subtree.
///
/// Presentation only: it holds no player state and touches none. The
/// `AVPlayer` keeps playing across the transition because the cover hosts
/// the *same* manager (see `VideoPlayerView`), so entering and leaving
/// fullscreen never re-prepares, re-seeks or re-creates anything.
@MainActor
final class VideoFullscreenController: ObservableObject {
    /// Settable (not `private(set)`) because `.fullScreenCover` needs a
    /// two-way binding: a system dismissal — the interactive swipe on iOS —
    /// has to write `false` back here.
    @Published var isFullscreen: Bool = false

    /// Applies an intent raised by a node inside this Video's subtree.
    /// Reached through this controller, so `insideVideo` holds by
    /// construction.
    func handle(_ intent: VideoIntent) {
        isFullscreen = VideoFullscreenPresentation.next(
            current: isFullscreen,
            intent: intent,
            insideVideo: true
        )
    }
}

// MARK: - Environment

/// Nil outside a Video — where a `videoIntent` prop is inert.
private struct VideoFullscreenKey: EnvironmentKey {
    // `VideoFullscreenController` is a `@MainActor final class`, hence
    // implicitly Sendable, so a nil default is concurrency-safe without
    // isolation (same shape as `VideoPlaybackHostKey`).
    static let defaultValue: VideoFullscreenController? = nil
}

extension EnvironmentValues {
    var videoFullscreen: VideoFullscreenController? {
        get { self[VideoFullscreenKey.self] }
        set { self[VideoFullscreenKey.self] = newValue }
    }
}

// MARK: - Tap interception

/// Turns a node carrying a live `videoIntent` into the fullscreen control.
///
/// `simultaneousGesture`, not `gesture`/`highPriorityGesture`: the contract
/// says an `.onClick` wired alongside the intent "still dispatches
/// normally", and the element's own action tap (`applyTapGestures`, or a
/// `Button`'s positional action) is attached closer to the content. A
/// simultaneous gesture recognizes *alongside* that one, so one tap runs
/// both — the action dispatches and the container toggles. An exclusive
/// gesture would make one of the two silently swallow the other, in a
/// direction that depends on nesting.
///
/// `contentShape` makes the node interactive on the intent alone, so no
/// `.onClick` is required; `TapGesture` needs a completed press-and-release
/// on the node, so a press that drifts off does nothing.
private struct VideoIntentTapModifier: ViewModifier {
    let intent: VideoIntent?

    @Environment(\.videoFullscreen) private var controller

    @ViewBuilder
    func body(content: Content) -> some View {
        if let intent = intent, let controller = controller {
            content
                // The whole frame is the control, not just its glyph.
                .contentShape(Rectangle())
                .simultaneousGesture(
                    TapGesture().onEnded { controller.handle(intent) }
                )
        } else {
            // No intent, or no enclosing Video: untouched.
            content
        }
    }
}

extension View {
    /// Applied to every rendered element (see `HypenElementView`); a no-op
    /// for the overwhelming majority that carry no intent.
    @MainActor
    func videoIntentTap(_ intent: VideoIntent?) -> some View {
        modifier(VideoIntentTapModifier(intent: intent))
    }
}

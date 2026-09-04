import SwiftUI

// MARK: - Scrubber Component

/// Handler for `Scrubber` — the timeline widget designed for a Video's
/// `controls` slot (see `hypen-web/docs/components/video.md`
/// §"Playback control & composition slots (draft spec — v2)").
///
/// Inside a Video the scrubber wires itself to the **enclosing player
/// renderer-side** (`\.videoPlaybackHost`): the thumb tracks playback off
/// the player's own 250 ms observer without touching module state, dragging
/// previews purely locally, and only the release commits. Commit
/// resolution (normative): the Scrubber's own `.bind(...)` wins, else the
/// enclosing Video's bind, else the `onSeek` action
/// (`{type: "seek", position}`) — and the local seek applies in every
/// case. That keeps scrubbing responsive on remote apps where a state
/// round trip costs a network hop.
///
/// Outside a Video there is nothing to drive: the scrubber renders an inert
/// track (no gestures, no accessibility, no dispatch).
///
/// Props:
/// - `bind` — the scrubber's own `.bind(@state.playback)` path; when set it
///   wins over the enclosing Video's bind as the commit channel.
/// - `onSeek` — action dispatched on release when nothing is bound.
///
/// Accessibility: the engine derives a `slider` role + name for `Scrubber`
/// (`ir/semantics.rs`); this view supplies the runtime value text
/// (`"1:05 of 3:20"`) and the adjustable ±5 s actions VoiceOver drives.
public struct ScrubberComponent: ComponentHandler {
    public let typeName = "scrubber"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let element = context.element
        let onSeek = ActionValue.from(element.props["onSeek"])
            ?? ActionValue.from(element.props["onSeek.0"])
        let ownBindPath = element.getStringProp("bind")

        return AnyView(
            ScrubberView(
                onSeek: onSeek,
                ownBindPath: ownBindPath,
                dispatcher: context.actionDispatcher
            )
            .hypenModifier(modifier)
        )
    }
}

// MARK: - Scrubber View

private struct ScrubberView: View {
    let onSeek: ActionValue?
    let ownBindPath: String?
    let dispatcher: ActionDispatcher

    @Environment(\.videoPlaybackHost) private var host

    var body: some View {
        if let host = host {
            ScrubberTimelineView(
                host: host,
                timeline: host.timeline,
                onSeek: onSeek,
                ownBindPath: ownBindPath,
                dispatcher: dispatcher
            )
        } else {
            // Inert outside a Video: a dead track, no gestures, no a11y.
            ScrubberTrack(progress: 0, showsThumb: false)
                .frame(height: ScrubberStyle.rowHeight)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }
}

/// The live scrubber: tracks the enclosing player, previews drags locally,
/// commits on release.
private struct ScrubberTimelineView: View {
    let host: VideoPlayerManager
    /// Observed separately from the manager so the 250 ms playhead tick
    /// invalidates the scrubber alone.
    @ObservedObject var timeline: VideoTimeline
    let onSeek: ActionValue?
    let ownBindPath: String?
    let dispatcher: ActionDispatcher

    /// Non-nil while a drag is in flight — the preview is purely local,
    /// never a state write.
    @State private var dragFraction: Double?

    private var fraction: Double {
        dragFraction
            ?? ScrubberMath.fraction(position: timeline.position, duration: timeline.duration)
    }

    /// The playhead the UI is showing: the drag preview while dragging,
    /// the player's real position otherwise.
    private var displayedPosition: Double {
        if let dragFraction = dragFraction {
            return ScrubberMath.position(
                forFraction: dragFraction, duration: timeline.duration
            )
        }
        return timeline.position
    }

    var body: some View {
        ScrubberTrack(progress: fraction, showsThumb: true)
            .frame(height: ScrubberStyle.rowHeight)
            .contentShape(Rectangle())
            .overlay {
                GeometryReader { geometry in
                    // A transparent hit surface carrying the drag: it gives
                    // the gesture the track's width without letting a
                    // GeometryReader dictate the widget's own sizing.
                    Color.clear
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { value in
                                    dragFraction = ScrubberMath.fraction(
                                        forX: Double(value.location.x),
                                        width: Double(geometry.size.width)
                                    )
                                }
                                .onEnded { value in
                                    let released = ScrubberMath.fraction(
                                        forX: Double(value.location.x),
                                        width: Double(geometry.size.width)
                                    )
                                    dragFraction = nil
                                    commit(
                                        position: ScrubberMath.position(
                                            forFraction: released,
                                            duration: timeline.duration
                                        )
                                    )
                                }
                        )
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityValue(
                Text(
                    ScrubberMath.accessibilityValue(
                        position: displayedPosition, duration: timeline.duration
                    )
                )
            )
            // SwiftUI has no `.isAdjustable` trait: registering an
            // adjustable action IS how a view becomes adjustable to
            // VoiceOver (swipe up/down = ±5 s).
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment:
                    adjust(by: VideoPlaybackConstants.accessibilitySeekStep)
                case .decrement:
                    adjust(by: -VideoPlaybackConstants.accessibilitySeekStep)
                @unknown default:
                    break
                }
            }
    }

    private func adjust(by delta: Double) {
        commit(
            position: ScrubberMath.adjusted(
                position: timeline.position,
                duration: timeline.duration,
                by: delta
            )
        )
    }

    /// Seek the player immediately (renderer-local, no round trip), then
    /// commit the new position to whichever channel the author wired up.
    private func commit(position: Double) {
        host.commitScrub(to: position)

        switch ScrubberCommit.plan(
            enclosingBindPath: host.bindPath,
            ownBindPath: ownBindPath,
            hasOnSeek: onSeek != nil
        ) {
        case .enclosingBind:
            // The player's own seek already reported `position` through the
            // Video's bind.
            break

        case .ownBind(let path):
            dispatcher.dispatch(action: "__hypen_bind", payload: [
                "path": "\(path).position",
                "value": position,
            ])

        case .seekAction:
            guard let onSeek = onSeek else { break }
            var payload = onSeek.payload
            payload["type"] = "seek"
            payload["position"] = position
            dispatcher.dispatch(action: onSeek.actionName, payload: payload)

        case .localOnly:
            break
        }
    }
}

// MARK: - Track

private enum ScrubberStyle {
    /// Touch-target row the track is centred in.
    static let rowHeight: CGFloat = 24
    static let trackHeight: CGFloat = 4
    static let thumbSize: CGFloat = 12
    static let track = Color(red: 0.90, green: 0.91, blue: 0.92)      // #E5E7EB
    static let progress = Color(red: 0.23, green: 0.51, blue: 0.96)   // #3B82F6
}

/// Track + progress + thumb. Pure presentation — all positioning comes from
/// `ScrubberMath`.
private struct ScrubberTrack: View {
    let progress: Double
    let showsThumb: Bool

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let clamped = min(max(progress, 0), 1)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: ScrubberStyle.trackHeight / 2)
                    .fill(ScrubberStyle.track)
                    .frame(height: ScrubberStyle.trackHeight)

                RoundedRectangle(cornerRadius: ScrubberStyle.trackHeight / 2)
                    .fill(ScrubberStyle.progress)
                    .frame(width: width * CGFloat(clamped), height: ScrubberStyle.trackHeight)

                if showsThumb {
                    Circle()
                        .fill(ScrubberStyle.progress)
                        .frame(width: ScrubberStyle.thumbSize, height: ScrubberStyle.thumbSize)
                        .offset(
                            x: max(
                                0,
                                min(
                                    width - ScrubberStyle.thumbSize,
                                    width * CGFloat(clamped) - ScrubberStyle.thumbSize / 2
                                )
                            )
                        )
                }
            }
            .frame(maxHeight: .infinity)
        }
    }
}

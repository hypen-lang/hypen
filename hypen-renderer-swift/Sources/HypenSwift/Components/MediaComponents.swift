import SwiftUI
import AVKit
import AVFoundation
import Combine

// MARK: - Audio Component

/// Handler for Audio components.
/// Uses AVFoundation for audio playback with a custom UI.
///
/// Audio source is passed as an argument: Audio(src: "url")
/// Supports autoplay and loop options.
public struct AudioComponent: ComponentHandler {
    public let typeName = "audio"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Audio source from props
        let src = context.element.getStringProp("0")
            ?? context.element.getStringProp("src")
            ?? context.element.getStringProp("source")

        // Autoplay
        let autoplay = context.element.getBoolProp("autoplay")
            ?? context.element.getBoolProp("autoplay.0")
            ?? false

        // Loop
        let loop = context.element.getBoolProp("loop")
            ?? context.element.getBoolProp("loop.0")
            ?? false

        guard let src = src, let url = URL(string: src) else {
            // No source - render children (for playlist UI, etc.)
            return AnyView(
                Group {
                    children()
                }
                .hypenModifier(modifier)
            )
        }

        return AnyView(
            AudioPlayerView(url: url, autoplay: autoplay, loop: loop)
                .hypenModifier(modifier)
        )
    }
}

// MARK: - Audio Player View

/// Internal SwiftUI view that manages audio playback state
private struct AudioPlayerView: View {
    let url: URL
    let autoplay: Bool
    let loop: Bool

    @StateObject private var playerManager: AudioPlayerManager

    init(url: URL, autoplay: Bool, loop: Bool) {
        self.url = url
        self.autoplay = autoplay
        self.loop = loop
        _playerManager = StateObject(wrappedValue: AudioPlayerManager(url: url, autoplay: autoplay, loop: loop))
    }

    var body: some View {
        HStack(spacing: 12) {
            // Play/Pause button
            Button(action: {
                playerManager.togglePlayPause()
            }) {
                Circle()
                    .fill(Color(red: 0.23, green: 0.51, blue: 0.96)) // #3B82F6
                    .frame(width: 40, height: 40)
                    .overlay(
                        Image(systemName: playerManager.isPlaying ? "pause.fill" : "play.fill")
                            .foregroundColor(.white)
                            .font(.system(size: 16))
                    )
            }
            .buttonStyle(PlainButtonStyle())

            // Progress bar
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    // Track
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(red: 0.90, green: 0.91, blue: 0.92)) // #E5E7EB
                        .frame(height: 4)

                    // Progress
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(red: 0.23, green: 0.51, blue: 0.96)) // #3B82F6
                        .frame(width: geometry.size.width * CGFloat(playerManager.progress), height: 4)
                }
            }
            .frame(height: 4)

            // Duration text
            Text("\(formatDuration(playerManager.currentTime)) / \(formatDuration(playerManager.duration))")
                .font(.system(size: 12))
                .foregroundColor(Color(red: 0.42, green: 0.45, blue: 0.50)) // #6B7280
                .monospacedDigit()
        }
        .padding(12)
        .background(Color(red: 0.95, green: 0.96, blue: 0.96)) // #F3F4F6
        .onDisappear {
            playerManager.cleanup()
        }
    }

    private func formatDuration(_ seconds: Double) -> String {
        guard seconds.isFinite && seconds >= 0 else { return "0:00" }
        let totalSeconds = Int(seconds)
        let minutes = totalSeconds / 60
        let secs = totalSeconds % 60
        return "\(minutes):\(String(format: "%02d", secs))"
    }
}

// MARK: - Audio Player Manager

/// Observable class that manages AVPlayer for audio playback
@MainActor
private class AudioPlayerManager: ObservableObject {
    @Published var isPlaying = false
    @Published var progress: Double = 0
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var cancellables = Set<AnyCancellable>()

    init(url: URL, autoplay: Bool, loop: Bool) {
        setupPlayer(url: url, autoplay: autoplay, loop: loop)
    }

    private func setupPlayer(url: URL, autoplay: Bool, loop: Bool) {
        let playerItem = AVPlayerItem(url: url)
        player = AVPlayer(playerItem: playerItem)

        // Observe playback status
        playerItem.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                Task { @MainActor in
                    guard let self = self else { return }
                    if status == .readyToPlay {
                        self.duration = playerItem.duration.seconds
                        if autoplay {
                            self.player?.play()
                            self.isPlaying = true
                        }
                    }
                }
            }
            .store(in: &cancellables)

        // Periodic time observer
        let interval = CMTime(seconds: 0.5, preferredTimescale: CMTimeScale(NSEC_PER_SEC))
        timeObserver = player?.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            Task { @MainActor in
                guard let self = self else { return }
                let current = time.seconds
                self.currentTime = current
                if self.duration > 0 {
                    self.progress = current / self.duration
                }
            }
        }

        // Handle playback end
        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: playerItem)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self = self else { return }
                    if loop {
                        self.player?.seek(to: .zero)
                        self.player?.play()
                    } else {
                        self.isPlaying = false
                        self.progress = 0
                        self.currentTime = 0
                        self.player?.seek(to: .zero)
                    }
                }
            }
            .store(in: &cancellables)
    }

    func togglePlayPause() {
        guard let player = player else { return }
        if isPlaying {
            player.pause()
        } else {
            player.play()
        }
        isPlaying.toggle()
    }

    func cleanup() {
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
        }
        player?.pause()
        player = nil
        cancellables.removeAll()
    }

    deinit {
        // Note: cleanup() should be called from onDisappear since deinit is not on MainActor
    }
}

// MARK: - Video Component

/// Handler for Video components implementing the cross-platform Video
/// contract (see `hypen-docs/content/docs/guide/components.mdx`).
///
/// Props:
/// - `0` / `src` / `source` — resolved streamable URL
/// - `playlist` — ordered play queue (supersedes `src` when non-empty)
/// - `startIndex` — initial playlist index (clamped)
/// - `poster` — image URL overlaid until the first frame plays
/// - `controls` / `autoplay` / `loop` / `muted` — playback flags
/// - `headers` — extra HTTP headers, applied via
///   `AVURLAsset(url:, options: ["AVURLAssetHTTPHeaderFieldsKey": headers])`
/// - `objectFit` — contain (default) / cover / fill → AVLayerVideoGravity
/// - `preload` — web buffering hint, ignored (AVFoundation buffers itself)
///
/// Events (optional `@actions.*` props): `onPlay`, `onPause`, `onEnded`,
/// `onTrackChange`, `onError` — dispatched with the contract payloads
/// through the context's `ActionDispatcher`.
///
/// Playlist advance uses AVPlayerItem replacement on
/// `AVPlayerItemDidPlayToEndTime` (contract iOS note: "queue via item
/// replacement"). `loop` on a playlist wraps to track 0; on a single src
/// it loops silently (seek 0 + play, no per-lap `onEnded`).
///
/// ## v2 (see the contract's §"Playback control & composition slots")
///
/// - `playback` + `bind` — the bound `{playing, position, duration, state}`
///   struct. Inbound writes become play/pause/seek commands
///   (`PlaybackCommandResolver`); outbound reports go back per key as
///   `__hypen_bind` writes on `<bind>.<key>` (`PlaybackBindReporter`).
/// - `startPosition` — one-time seek applied when the item becomes ready.
/// - `.slot("controls"|"loading"|"error"|"poster")` children — overlaid
///   full-bleed on the player surface, shown/hidden strictly per
///   `VideoSlotVisibility` (never mounted/unmounted, so slot subtree state
///   survives every transition). A present slot replaces the built-in for
///   its concern; a `controls` slot suppresses the native transport chrome
///   regardless of the `controls` prop.
///
/// The player state itself is derived by `VideoPlayerStateMachine` — all
/// the interesting logic lives in `VideoPlayback.swift` as pure values.
public struct VideoComponent: ComponentHandler {
    public let typeName = "video"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        let element = context.element

        // Source resolution: a non-empty `playlist` supersedes `src`.
        let src = element.getStringProp("0")
            ?? element.getStringProp("src")
            ?? element.getStringProp("src.0")
            ?? element.getStringProp("source")
            ?? element.getStringProp("source.0")
        let playlist = element.getStringListProp("playlist") ?? []

        let sources: [String]
        let isPlaylist: Bool
        if !playlist.isEmpty {
            sources = playlist
            isPlaylist = true
        } else if let src = src, !src.isEmpty {
            sources = [src]
            isPlaylist = false
        } else {
            // Contract failure mode 1: no src and no playlist — render an
            // empty placeholder box. No crash, no dispatch.
            return AnyView(Color.clear.hypenModifier(modifier))
        }

        let rawStartIndex = element.getIntProp("startIndex")
            ?? element.getIntProp("startIndex.0")
            ?? 0
        let startIndex = isPlaylist
            ? min(max(rawStartIndex, 0), sources.count - 1)
            : 0

        let showControls = element.getBoolProp("controls")
            ?? element.getBoolProp("controls.0")
            ?? false
        let autoplay = element.getBoolProp("autoplay")
            ?? element.getBoolProp("autoplay.0")
            ?? false
        let loop = element.getBoolProp("loop")
            ?? element.getBoolProp("loop.0")
            ?? false
        let muted = element.getBoolProp("muted")
            ?? element.getBoolProp("muted.0")
            ?? false

        let poster = element.getStringProp("poster")
            ?? element.getStringProp("poster.0")
        let objectFit = element.getStringProp("objectFit")
            ?? element.getStringProp("objectFit.0")
        let headers = element.getStringMapProp("headers") ?? [:]

        // v2: the bound playback struct. `.bind(@state.playback)` lowers to
        // the resolved `playback` object plus the `bind` path string (see
        // the engine's `ir/expand.rs`); `playing:` alone is the one-way
        // controlled subset.
        let bindPath = element.getStringProp("bind")
        let playbackInput = VideoPlaybackInput.from(
            playbackProp: element.props["playback"] ?? element.props["playback.0"],
            playingProp: element.getBoolProp("playing") ?? element.getBoolProp("playing.0")
        )
        let startPosition = element.getDoubleProp("startPosition")
            ?? element.getDoubleProp("startPosition.0")

        let bindings = VideoEventBindings.from(element)

        // Key the player view on its media identity (sources + startIndex +
        // headers). When any of those props change, SwiftUI sees a new view
        // identity: the old view is torn down and a fresh VideoPlayerManager
        // is built for the new configuration — which is also what re-arms
        // `startPosition` on a source-config change (spec: it re-arms when
        // `src`/`playlist`/`headers` change, not on unrelated prop updates).
        //
        // `playback` / `startPosition` / the runtime config are deliberately
        // NOT part of the identity: they steer the live player, they don't
        // replace it (see `applyRuntimeConfig` / `applyPlaybackInput`).
        let identity = Self.mediaIdentity(
            sources: sources, startIndex: startIndex, headers: headers
        )

        return AnyView(
            VideoPlayerView(
                elementId: element.id,
                renderer: context.renderer,
                sources: sources,
                startIndex: startIndex,
                isPlaylist: isPlaylist,
                headers: headers,
                showControls: showControls,
                poster: poster,
                objectFit: objectFit,
                startPosition: startPosition,
                playbackInput: playbackInput,
                runtimeConfig: VideoRuntimeConfig(
                    muted: muted,
                    loop: loop,
                    autoplay: autoplay,
                    bindPath: bindPath,
                    bindings: bindings
                ),
                dispatcher: context.actionDispatcher
            )
            .id(identity)
            .hypenModifier(modifier)
        )
    }

    private static func mediaIdentity(
        sources: [String], startIndex: Int, headers: [String: String]
    ) -> String {
        let headerKey = headers
            .sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: "\u{1F}")
        return sources.joined(separator: "\u{1F}")
            + "\u{1E}\(startIndex)\u{1E}"
            + headerKey
    }
}

// MARK: - Video Event Bindings

/// The parsed `@actions.*` event props of a Video element. Applied at
/// player creation time and re-applied on every prop update (they are
/// deliberately outside the media identity; see `VideoComponent.render`
/// and `VideoPlayerManager.applyRuntimeConfig`).
///
/// Internal (not private) because `VideoPlayerManager` — which the
/// `Scrubber` reaches through the environment — takes it in its
/// initializer.
struct VideoEventBindings: Equatable {
    var onPlay: ActionValue?
    var onPause: ActionValue?
    var onEnded: ActionValue?
    var onTrackChange: ActionValue?
    var onError: ActionValue?

    @MainActor
    static func from(_ element: HypenElement) -> VideoEventBindings {
        func action(_ name: String) -> ActionValue? {
            ActionValue.from(element.props[name] ?? element.props["\(name).0"])
        }
        return VideoEventBindings(
            onPlay: action("onPlay"),
            onPause: action("onPause"),
            onEnded: action("onEnded"),
            onTrackChange: action("onTrackChange"),
            onError: action("onError")
        )
    }
}

// MARK: - Video Runtime Config

/// The identity-independent playback props of a Video element — the ones
/// that steer the live player rather than replace it. They are deliberately
/// NOT part of `mediaIdentity`, so a change to any of them must be applied
/// imperatively to the existing `VideoPlayerManager`
/// (`applyRuntimeConfig(_:)`) instead of being consumed once at
/// `@StateObject` init: `muted: "@{state.muted}"` toggled by a module has to
/// reach the live `AVPlayer`, a `loop` flip has to reach the queue's
/// end-of-track policy, and re-bound `@actions.*` props have to reach event
/// dispatch — exactly as the DOM renderer applies each `SetProp`.
struct VideoRuntimeConfig: Equatable {
    var muted: Bool
    var loop: Bool
    /// Load-time flag: like the DOM's `el.autoplay`, a runtime change has no
    /// effect on an already-created player, but the live value is kept so
    /// any future (re)load honors it.
    var autoplay: Bool
    var bindPath: String?
    var bindings: VideoEventBindings
}

// MARK: - Video Player View

/// Internal SwiftUI view that manages video playback and the v2 slot
/// overlays.
private struct VideoPlayerView: View {
    /// The Video node's engine id — slot children are looked up through the
    /// renderer at body time (like `HypenAppComponent`'s slots) so children
    /// that arrive, move or disappear via patches are always current.
    let elementId: String
    let renderer: HypenRenderer
    let showControls: Bool
    let poster: String?
    let objectFit: String?
    let playbackInput: VideoPlaybackInput
    let runtimeConfig: VideoRuntimeConfig
    let dispatcher: ActionDispatcher

    @StateObject private var manager: VideoPlayerManager

    /// Renderer-local fullscreen presentation of the container
    /// (`.videoIntent("fullscreen")` — see `VideoIntents.swift`). Owned
    /// here, published to the whole Video subtree, and deliberately outside
    /// the media identity: it is presentation, not player state.
    @StateObject private var fullscreen: VideoFullscreenController

    init(
        elementId: String,
        renderer: HypenRenderer,
        sources: [String],
        startIndex: Int,
        isPlaylist: Bool,
        headers: [String: String],
        showControls: Bool,
        poster: String?,
        objectFit: String?,
        startPosition: Double?,
        playbackInput: VideoPlaybackInput,
        runtimeConfig: VideoRuntimeConfig,
        dispatcher: ActionDispatcher
    ) {
        self.elementId = elementId
        self.renderer = renderer
        self.showControls = showControls
        self.poster = poster
        self.objectFit = objectFit
        self.playbackInput = playbackInput
        self.runtimeConfig = runtimeConfig
        self.dispatcher = dispatcher
        _manager = StateObject(wrappedValue: VideoPlayerManager(
            sources: sources,
            startIndex: startIndex,
            isPlaylist: isPlaylist,
            headers: headers,
            runtime: runtimeConfig,
            startPosition: startPosition,
            dispatcher: dispatcher
        ))
        _fullscreen = StateObject(wrappedValue: VideoFullscreenController())
    }

    var body: some View {
        presentation
            // The intent channel: only a Video publishes it, so a
            // `videoIntent` node anywhere else stays inert.
            .environment(\.videoFullscreen, fullscreen)
            .onAppear {
                // Props may have changed while the @StateObject slept
                // through a previous disappear/appear cycle — re-apply the
                // runtime config before resuming.
                manager.applyRuntimeConfig(runtimeConfig)
                // Re-arm after a disappear/appear cycle (NavigationStack
                // pop, TabView switch, lazy-container re-entry): resume
                // playback if it was playing when the view left the screen.
                manager.resumeIfSuspended()
                // `playing: true` already in module state starts playback
                // exactly like `autoplay`; an initial `false` is treated as
                // "unset" so it can't cancel `autoplay` (see
                // `applyPlaybackInput(_:initial:)`).
                manager.applyPlaybackInput(playbackInput, initial: true)
            }
            .onChangeCompat(of: runtimeConfig) { config in
                manager.applyRuntimeConfig(config)
            }
            .onChangeCompat(of: playbackInput) { input in
                manager.applyPlaybackInput(input)
            }
            .onDisappear {
                // A full-screen cover takes the presenting view out of the
                // window, which SwiftUI reports here as an ordinary
                // disappearance — suspending on it would pause the very
                // playback the viewer just asked to see fullscreen.
                // Fullscreen is presentation only (contract), so this is the
                // one disappearance that must not suspend.
                guard !fullscreen.isFullscreen else { return }
                // Suspend, never tear down: the @StateObject manager
                // survives a disappear/appear cycle (NavigationStack push,
                // TabView switch, lazy-container culling), so destroying
                // the item/observers here would leave a permanently dead
                // surface on reappear. Suspending pauses playback (audio
                // never keeps running off-screen) and keeps the item,
                // observers and position alive; final teardown happens in
                // the manager's deinit when SwiftUI releases it.
                manager.suspend()
            }
    }

    // MARK: Fullscreen presentation

    /// In page, or in a full-screen cover hosting the *same* container.
    ///
    /// The cover presents `container` — surface plus every composition slot
    /// — never a bare player: fullscreening the container is what keeps the
    /// author's controls overlaid, and it is why `AVPlayerViewController`'s
    /// native fullscreen (which swaps in its own chrome) is not used.
    ///
    /// The `AVPlayer` and its `VideoPlayerManager` are untouched by the
    /// transition: both live on this view, which stays alive throughout, so
    /// the cover's player layer attaches to the *existing* player. Nothing
    /// re-prepares, re-seeks or re-creates — position, buffer and play
    /// intent carry straight through.
    ///
    /// macOS has no `fullScreenCover`; there the intent stays inert (the
    /// contract's "inert where unimplemented").
    @ViewBuilder
    private var presentation: some View {
        #if os(macOS)
        container
        #else
        inPage
            .fullScreenCover(isPresented: $fullscreen.isFullscreen) {
                fullscreenLayer
            }
        #endif
    }

    /// While fullscreen, the in-page slot keeps the element's layout box but
    /// hosts no second player surface — two layers on one `AVPlayer` would
    /// fight over the video.
    @ViewBuilder
    private var inPage: some View {
        if fullscreen.isFullscreen {
            Color.black
        } else {
            container
        }
    }

    private var fullscreenLayer: some View {
        ZStack {
            Color.black
            container
        }
        .ignoresSafeArea()
        // Presented content is hosted separately; re-inject the Video's
        // environment so slot chrome (the Scrubber, and the intent button
        // that toggles fullscreen back off) keeps working inside the cover.
        .environment(\.videoPlaybackHost, manager)
        .environment(\.videoFullscreen, fullscreen)
    }

    /// The video container: the player surface with the built-in error and
    /// poster treatments and every composition slot overlaid on it. This is
    /// the unit `videoIntent("fullscreen")` targets.
    private var container: some View {
        playerSurface
            .overlay {
                if manager.playerState == .error && !hasSlot(.error) {
                    // Contract: quiet failure — dark box (poster stays on
                    // top when present). Never a spinner, never a crash.
                    // An `error` slot replaces this surface entirely.
                    Color.black
                }
            }
            .overlay {
                if shouldShowBuiltInPoster, let posterURL = posterURL {
                    // Best-effort poster: shown until the first frame plays
                    // (and kept during the failed state). Backed by black so
                    // the video's letterboxing doesn't peek through, clipped
                    // to the player's bounds, and transparent to hits so
                    // native transport controls stay tappable.
                    //
                    // This is the SHIPPED behaviour, kept verbatim: the spec
                    // is explicit that absent slots change nothing. A
                    // `poster` slot replaces it and follows the v2 table.
                    Color.black
                        .overlay {
                            HypenCachedImage(
                                url: posterURL,
                                placeholder: { Color.clear },
                                failure: { Color.clear },
                                transform: { image in
                                    AnyView(image.resizable().scaledToFill())
                                }
                            )
                        }
                        .clipped()
                        .allowsHitTesting(false)
                }
            }
            .overlay { slotLayers }
    }

    // MARK: Built-ins

    private var posterURL: URL? {
        guard let poster = poster, !poster.isEmpty else { return nil }
        return URL(string: poster)
    }

    private var shouldShowBuiltInPoster: Bool {
        guard !hasSlot(.poster) else { return false }
        return !manager.hasStartedPlaying || manager.playerState == .error
    }

    /// A `controls` slot suppresses the native transport chrome regardless
    /// of the `controls` prop (contract: a present slot replaces the
    /// built-in for that concern).
    private var usesNativeControls: Bool {
        showControls && !hasSlot(.controls)
    }

    @ViewBuilder
    private var playerSurface: some View {
        #if os(watchOS)
        // watchOS has no SwiftUI VideoPlayer; fall through to the
        // representable's placeholder.
        VideoPlayerRepresentable(player: manager.player, objectFit: objectFit)
        #else
        if usesNativeControls {
            // System VideoPlayer with native transport controls
            VideoPlayer(player: manager.player)
        } else {
            // Bare player layer without native controls. Author-supplied
            // chrome (a `controls` slot) needs no tap-to-start affordance
            // here: the visibility table shows the controls slot in `idle`,
            // so the slot's own play button handles first play.
            VideoPlayerRepresentable(player: manager.player, objectFit: objectFit)
        }
        #endif
    }

    // MARK: Slots

    /// The slot overlays, painted back-to-front (`VideoSlot.paintOrder`,
    /// normative): poster backdrop, spinner, transport chrome, error
    /// surface on top.
    ///
    /// Every present slot is always mounted — visibility is opacity +
    /// hit-testing + accessibility, never `if`. Slot subtrees therefore keep
    /// their SwiftUI state (and their hosted child views) across every
    /// player-state transition, exactly as the contract requires.
    @ViewBuilder
    private var slotLayers: some View {
        let state = manager.playerState
        ZStack {
            slotLayer(.poster, state: state)
            slotLayer(.loading, state: state)
            slotLayer(.controls, state: state)
            slotLayer(.error, state: state)
        }
        .environment(\.videoPlaybackHost, manager)
    }

    @ViewBuilder
    private func slotLayer(_ slot: VideoSlot, state: VideoPlayerState) -> some View {
        let ids = slotChildIds(slot)
        if !ids.isEmpty {
            let visible = VideoSlotVisibility.isVisible(slot, in: state)
            ZStack {
                ForEach(ids, id: \.self) { childId in
                    HypenElementView(
                        elementId: childId,
                        renderer: renderer,
                        actionDispatcher: dispatcher
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .opacity(visible ? 1 : 0)
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
        }
    }

    private func hasSlot(_ slot: VideoSlot) -> Bool {
        !slotChildIds(slot).isEmpty
    }

    /// Children tagged `.slot(name)` — the applicator lowers to a `slot.0`
    /// prop. Untagged children are invalid for a Video (it is a leaf for
    /// ordinary children) and are dropped.
    private func slotChildIds(_ slot: VideoSlot) -> [String] {
        guard let element = renderer.getElement(elementId) else { return [] }
        return element.children.filter { childId in
            guard let child = renderer.getElement(childId) else { return false }
            let name = child.getStringProp("slot.0") ?? child.getStringProp("slot")
            return VideoSlot.named(name) == slot
        }
    }
}

// MARK: - Playback host environment

/// The enclosing Video's player, published to its slot subtrees so
/// slot-aware chrome (`Scrubber`) can drive it renderer-side without a
/// module round trip. Nil outside a Video — where `Scrubber` renders inert.
private struct VideoPlaybackHostKey: EnvironmentKey {
    // `VideoPlayerManager` is a @MainActor final class, hence implicitly
    // Sendable, so a nil default is concurrency-safe without isolation.
    static let defaultValue: VideoPlayerManager? = nil
}

extension EnvironmentValues {
    var videoPlaybackHost: VideoPlayerManager? {
        get { self[VideoPlaybackHostKey.self] }
        set { self[VideoPlaybackHostKey.self] = newValue }
    }
}

// MARK: - Video Timeline

/// The high-frequency half of the player's published state, split off from
/// `VideoPlayerManager` on purpose: the 250 ms position tick invalidates
/// only the views that actually read the playhead (the `Scrubber`), not the
/// whole Video subtree and its slot children.
@MainActor
final class VideoTimeline: ObservableObject {
    @Published fileprivate(set) var position: Double = 0
    @Published fileprivate(set) var duration: Double = 0
}

// MARK: - Player teardown handle

/// Final-teardown handle for `VideoPlayerManager`. A nonisolated `deinit`
/// of a `@MainActor` class may only access its *Sendable* stored
/// properties, so the AVPlayer and its periodic-observer token are reached
/// through this box instead. `@unchecked`: AVPlayer's transport API is
/// thread-safe, and by `deinit` time the handle has exclusive access.
private final class VideoPlayerTeardownHandle: @unchecked Sendable {
    let player: AVPlayer
    /// The 250 ms periodic time observer token; must be removed from the
    /// player explicitly before the player goes away.
    var positionObserver: Any?

    init(player: AVPlayer) {
        self.player = player
    }

    func tearDown() {
        if let observer = positionObserver {
            player.removeTimeObserver(observer)
            positionObserver = nil
        }
        player.pause()
        player.replaceCurrentItem(with: nil)
    }
}

// MARK: - Video Player Manager

/// Observable class that owns the AVPlayer, the play queue, and event
/// dispatch for a Video element.
///
/// Playlist playback replaces the AVPlayer's current item on
/// `AVPlayerItemDidPlayToEndTime` rather than using AVQueuePlayer, so the
/// manager always knows the current index, can dispatch `onTrackChange`,
/// and can wrap the queue to track 0 when `loop` is set.
///
/// v2: the class owns no state-derivation logic of its own — it feeds raw
/// AVPlayer signals into `VideoPlayerStateMachine` / `VideoQueue` and pushes
/// the results out as events, `__hypen_bind` writes and `@Published` state.
@MainActor
final class VideoPlayerManager: ObservableObject {
    let player: AVPlayer

    /// The playhead/duration channel, observed by the `Scrubber` alone.
    let timeline = VideoTimeline()

    /// The normative player state; drives slot visibility and the bind
    /// struct's `state` key.
    @Published private(set) var playerState: VideoPlayerState = .idle

    /// Flips true on the first `.playing` time-control status; hides the
    /// built-in poster overlay (shipped behaviour, kept for slot-less use).
    @Published private(set) var hasStartedPlaying = false

    /// The bound state path from `.bind(@state.playback)`, or nil. Read by
    /// the `Scrubber` to decide where a released scrub commits. Kept current
    /// by `applyRuntimeConfig(_:)`.
    private(set) var bindPath: String?

    private let sources: [String]
    private let headers: [String: String]
    /// `isPlaylist` + `loop` live here as the queue's end-of-track policy.
    /// Rebuilt (same sources, new `loop`) when the `loop` prop changes at
    /// runtime; internal read so tests can assert the live policy.
    private(set) var queue: VideoQueue
    private var bindings: VideoEventBindings
    /// Load-time flag, kept current so any future (re)load honors the live
    /// value (a runtime change has no effect on an already-created player,
    /// matching the DOM's `el.autoplay`).
    private var autoplay: Bool
    private let dispatcher: ActionDispatcher

    private(set) var currentIndex: Int

    /// Player-lifetime subscriptions (time-control status).
    private var playerCancellables = Set<AnyCancellable>()
    /// Per-item subscriptions (item status, did-play-to-end). Reset on
    /// every track change so stale items never fire handlers.
    private var itemCancellables = Set<AnyCancellable>()
    /// Owns the 250 ms playhead observer token (position reports + Scrubber
    /// tracking) and performs final teardown from `deinit`.
    private let teardownHandle: VideoPlayerTeardownHandle

    /// All play/pause/loading/ended/error derivation lives here.
    private var machine = VideoPlayerStateMachine()

    /// Throttled per-key `__hypen_bind` writer; nil when the node has no
    /// `.bind(...)`.
    private var reporter: PlaybackBindReporter?

    /// `startPosition`: applied once, when the first item becomes ready.
    private var pendingStartPosition: Double?

    /// One onError dispatch per item, max.
    private var reportedErrorForCurrentItem = false

    /// Set while the hosting view is off-screen with the manager kept alive
    /// (NavigationStack push, TabView switch, lazy-container culling):
    /// remembers whether playback should resume when the view reappears.
    /// Nil while the view is on screen.
    private var suspendedPlayIntent: Bool?

    /// True between `suspend()` and `resumeIfSuspended()`. Bind reports are
    /// muted while suspended: the shipped teardown cancelled subscriptions
    /// before pausing precisely so navigation never emitted trailing bind
    /// writes — and on an identity change (new `src`) a dying manager's
    /// stale `playing: false` on the SAME bind path would land after the
    /// replacement manager's reports, echo back through module state and
    /// pause the new player. Contract events (`onPause` on suspension,
    /// `onPlay` on resume) still dispatch; the bind re-syncs on resume.
    private var isSuspended = false

    init(
        sources: [String],
        startIndex: Int,
        isPlaylist: Bool,
        headers: [String: String],
        runtime: VideoRuntimeConfig,
        startPosition: Double?,
        dispatcher: ActionDispatcher
    ) {
        self.sources = sources
        self.headers = headers
        self.queue = VideoQueue(
            sourceCount: sources.count, isPlaylist: isPlaylist, loop: runtime.loop
        )
        self.bindings = runtime.bindings
        self.autoplay = runtime.autoplay
        self.dispatcher = dispatcher
        self.bindPath = runtime.bindPath
        self.currentIndex = isPlaylist
            ? min(max(startIndex, 0), max(sources.count - 1, 0))
            : 0
        let player = AVPlayer()
        self.player = player
        self.teardownHandle = VideoPlayerTeardownHandle(player: player)
        player.isMuted = runtime.muted

        // Reporting is opt-in: no `.bind(...)`, no bind traffic at all.
        if let path = runtime.bindPath, !path.isEmpty {
            self.reporter = PlaybackBindReporter(path: path)
        }
        if let start = startPosition, start.isFinite, start > 0 {
            self.pendingStartPosition = start
        }

        // Play/pause event tracking
        player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                Task { @MainActor in
                    self?.handleTimeControlStatus(status)
                }
            }
            .store(in: &playerCancellables)

        // Position reports are throttled to PLAYBACK_REPORT_INTERVAL_MS, so
        // observe at exactly that cadence.
        let interval = CMTime(
            seconds: VideoPlaybackConstants.reportInterval,
            preferredTimescale: CMTimeScale(NSEC_PER_SEC)
        )
        teardownHandle.positionObserver = player.addPeriodicTimeObserver(
            forInterval: interval, queue: .main
        ) { [weak self] time in
            Task { @MainActor in
                self?.handlePeriodicTime(time)
            }
        }

        loadTrack(at: currentIndex, playWhenReady: autoplay, notifyTrackChange: false)
    }

    // MARK: Track loading

    private func loadTrack(at index: Int, playWhenReady: Bool, notifyTrackChange: Bool) {
        currentIndex = index
        reportedErrorForCurrentItem = false
        itemCancellables.removeAll()
        timeline.position = 0
        timeline.duration = 0

        let src = sources[index]
        guard let url = URL(string: src) else {
            apply(.itemFailed)
            dispatchError(
                status: nil,
                code: nil,
                message: "Invalid video URL: \(src)"
            )
            return
        }

        // Clears any sticky error and re-arms the onPlay edge for the new
        // track.
        apply(.trackLoadStarted(playWhenReady: playWhenReady))

        let item = makeItem(for: url)
        observeCurrentItem(item)
        player.replaceCurrentItem(with: item)
        if playWhenReady {
            // play() before readyToPlay is fine: the player starts as soon
            // as the item can sustain playback.
            player.play()
        }
        if notifyTrackChange {
            dispatch(bindings.onTrackChange, [
                "type": "trackchange",
                "src": src,
                "index": index,
            ])
        }
        // Track change is a transition: position/duration reset immediately.
        reportPlayback(immediate: true)
    }

    /// Contract iOS note: headers ride on the asset via the (undocumented
    /// but standard) "AVURLAssetHTTPHeaderFieldsKey" option.
    private func makeItem(for url: URL) -> AVPlayerItem {
        guard !headers.isEmpty else {
            return AVPlayerItem(url: url)
        }
        let asset = AVURLAsset(
            url: url,
            options: ["AVURLAssetHTTPHeaderFieldsKey": headers]
        )
        return AVPlayerItem(asset: asset)
    }

    private func observeCurrentItem(_ item: AVPlayerItem) {
        // Handlers read `player.currentItem` instead of capturing the
        // (non-Sendable) item; itemCancellables are reset on every track
        // change, so these sinks only ever fire for the live item.
        item.publisher(for: \.status)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                Task { @MainActor in
                    guard let self = self else { return }
                    switch status {
                    case .failed:
                        self.handleItemFailed()
                    case .readyToPlay:
                        self.handleItemReady()
                    default:
                        break
                    }
                }
            }
            .store(in: &itemCancellables)

        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.handleTrackEnded()
                }
            }
            .store(in: &itemCancellables)
    }

    // MARK: Event handling

    /// Feed one signal to the state machine, then publish everything it
    /// implies: the contract play/pause events, the `@Published` state the
    /// slots key off, and an immediate bind report (transitions are never
    /// throttled).
    private func apply(_ event: VideoPlayerEvent) {
        let transition = machine.handle(event)

        if transition.dispatchPlay {
            dispatch(bindings.onPlay, [
                "type": "play",
                "src": currentSrc,
                "index": currentIndex,
            ])
        }
        if transition.dispatchPause {
            dispatch(bindings.onPause, [
                "type": "pause",
                "src": currentSrc,
                "index": currentIndex,
            ])
        }

        // Both are @Published: only assign on a real change, so a repeated
        // status never invalidates the Video's slot subtrees.
        if transition.state == .playing && !hasStartedPlaying {
            hasStartedPlaying = true
        }
        if playerState != transition.state {
            playerState = transition.state
        }
        if transition.changed || transition.dispatchPlay || transition.dispatchPause {
            reportPlayback(immediate: true)
        }
    }

    private func handleTimeControlStatus(_ status: AVPlayer.TimeControlStatus) {
        let control: VideoTimeControl
        switch status {
        case .playing:
            control = .playing
        case .waitingToPlayAtSpecifiedRate:
            control = .waitingToPlay
        case .paused:
            control = .paused
        @unknown default:
            // Never guess: an unknown status must not be able to synthesize
            // a pause event.
            return
        }
        apply(.timeControlChanged(control, atEnd: isAtEndOfCurrentItem))
    }

    /// Whether the live item's playhead has run out.
    ///
    /// `AVPlayerItemDidPlayToEndTime` and the `.paused` time-control status
    /// race at the end of an item; this is what lets the state machine tell
    /// "the item ended" from "the viewer paused" when the status wins, so
    /// the ended transition never emits a spurious `onPause`.
    private var isAtEndOfCurrentItem: Bool {
        guard let item = player.currentItem else { return false }
        let duration = item.duration.seconds
        guard duration.isFinite, duration > 0 else { return false }
        let current = item.currentTime().seconds
        guard current.isFinite else { return false }
        return current >= duration - VideoPlaybackConstants.endOfItemTolerance
    }

    private func handleTrackEnded() {
        let src = currentSrc
        let index = currentIndex
        let outcome = queue.outcome(at: index)

        // `completed` is the whole-queue flag: `isLast && !loop` on a
        // playlist (a wrap means the queue is NOT done), true for a
        // non-looping single source. A looping single source dispatches
        // nothing at all — it loops silently, native-style, exactly like
        // the DOM's `el.loop`. Both rules match DOM/canvas/Android/desktop.
        if outcome.dispatchEnded {
            dispatch(bindings.onEnded, [
                "type": "ended",
                "src": src,
                "index": index,
                "completed": outcome.completed,
            ])
        }

        apply(.playedToEnd(continuation: outcome.continuation))

        if let next = outcome.nextIndex {
            loadTrack(at: next, playWhenReady: true, notifyTrackChange: true)
        } else if outcome.continuation == .restartInPlace {
            seek(to: 0, thenPlay: true)
        }
    }

    private func handleItemReady() {
        refreshDuration()
        if let start = pendingStartPosition {
            // `startPosition`: a one-time create-time seek, applied as soon
            // as the source becomes seekable.
            pendingStartPosition = nil
            seek(to: start)
        } else {
            reportPlayback(immediate: true)
        }
    }

    private func handlePeriodicTime(_ time: CMTime) {
        let seconds = time.seconds
        if seconds.isFinite {
            timeline.position = max(0, seconds)
        }
        refreshDuration()
        // Throttled: the reporter drops position writes that land inside
        // the 250 ms window.
        reportPlayback(immediate: false)
    }

    private func refreshDuration() {
        guard let item = player.currentItem else { return }
        let seconds = item.duration.seconds
        let value = seconds.isFinite && seconds > 0 ? seconds : 0
        if abs(value - timeline.duration) > VideoPlaybackConstants.valueEpsilon {
            timeline.duration = value
        }
    }

    private func handleItemFailed() {
        guard !reportedErrorForCurrentItem else { return }
        reportedErrorForCurrentItem = true
        apply(.itemFailed)

        let item = player.currentItem
        let nsError = item?.error as NSError?

        // Best-effort HTTP status: the item's error log first, then the
        // NSError underlying chain. Omitted when unknown (contract).
        var status: Int?
        if let event = item?.errorLog()?.events.last {
            let logStatus = event.errorStatusCode
            if (100..<600).contains(logStatus) {
                status = logStatus
            }
        }
        if status == nil, let nsError = nsError {
            status = Self.httpStatus(from: nsError)
        }

        dispatchError(
            status: status,
            code: nsError?.code,
            message: nsError?.localizedDescription ?? "Video playback failed"
        )
    }

    private func dispatchError(status: Int?, code: Int?, message: String) {
        var payload: [String: Any] = [
            "type": "error",
            "src": currentSrc,
            "index": currentIndex,
            "message": message,
        ]
        if let status = status {
            payload["status"] = status
        }
        if let code = code {
            payload["code"] = code
        }
        dispatch(bindings.onError, payload)
    }

    /// Walk the NSError userInfo underlying-error chain looking for a
    /// derivable HTTP status. CoreMediaErrorDomain uses well-known (if
    /// undocumented) codes for common HTTP failures.
    private static func httpStatus(from error: NSError) -> Int? {
        var current: NSError? = error
        var depth = 0
        while let err = current, depth < 8 {
            if err.domain == "CoreMediaErrorDomain" {
                switch err.code {
                case -12938: return 404
                case -12660: return 403
                default: break
                }
            }
            current = err.userInfo[NSUnderlyingErrorKey] as? NSError
            depth += 1
        }
        return nil
    }

    // MARK: Transport (v2 playback bind + Scrubber)

    /// Start (or resume) playback. Used by the `playing: true` write (a
    /// controls-slot play button in `idle` commits through the bind or an
    /// action — there is no renderer-local tap-to-start).
    func requestPlay() {
        guard playerState != .error else { return }
        apply(.playRequested)
        player.play()
    }

    func requestPause() {
        // Applied up front rather than left to the `.paused` status it
        // causes: during pre-roll (a load that hasn't produced a frame yet)
        // a bare `.paused` is only a transient and is deliberately
        // swallowed, so an explicit request has to say so itself. The
        // status that follows lands on an already-paused machine and
        // dispatches nothing.
        apply(.pauseRequested)
        player.pause()
    }

    /// Seek, clamped to `[0, duration]`. The playhead is updated optimistically
    /// so the 1 s epsilon guard sees the new position immediately (a
    /// `position` write echoing straight back must not seek twice).
    func seek(to seconds: Double, thenPlay: Bool = false) {
        let target = PlaybackCommandResolver.clamp(seconds, duration: timeline.duration)
        timeline.position = target
        let time = CMTime(
            seconds: target, preferredTimescale: CMTimeScale(NSEC_PER_SEC)
        )
        player.seek(to: time) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                if let current = self.player.currentItem?.currentTime().seconds,
                   current.isFinite {
                    self.timeline.position = max(0, current)
                }
                // Seek completion is a transition: report immediately.
                self.reportPlayback(immediate: true)
            }
        }
        if thenPlay {
            player.play()
        }
    }

    /// A released `Scrubber` drag: seek locally and report through the bind
    /// (when the Video is bound). The Scrubber owns the bind-less fallbacks.
    func commitScrub(to seconds: Double) {
        seek(to: seconds)
    }

    /// Apply an inbound `playback` write (state → renderer).
    ///
    /// `initial` marks the first application, at mount. A module's freshly
    /// initialized struct reads `playing: false` before anything has
    /// happened, which is indistinguishable from "unset" — honouring it
    /// would cancel `autoplay` on every bound player. So the first pass
    /// carries only positive intent: a `playing: true` starts playback and
    /// a `position` seeks (the bind's version of "resume where you left
    /// off"), but a `playing: false` is ignored. Every later write is
    /// authoritative in both directions.
    func applyPlaybackInput(_ input: VideoPlaybackInput, initial: Bool = false) {
        guard !input.isEmpty else { return }
        var input = input
        if suspendedPlayIntent != nil {
            // Off-screen: an explicit (non-initial) `playing` write replaces
            // the saved resume intent — a pause taken while suspended must
            // not be undone by reappearing, and a play taken while suspended
            // resumes on reappear. The hidden player itself is never driven:
            // audio must not start off-screen. Seeks still apply.
            if !initial, let wants = input.playing {
                suspendedPlayIntent = wants
            }
            input.playing = nil
            guard !input.isEmpty else { return }
        }
        let commands = PlaybackCommandResolver.commands(
            input: input,
            current: currentSnapshot(),
            lastReportedPosition: reporter?.lastReportedPosition,
            isInitial: initial
        )
        for command in commands {
            switch command {
            case .play:
                requestPlay()
            case .pause:
                requestPause()
            case .restart:
                // `playing: true` written while `ended` restarts from 0.
                seek(to: 0, thenPlay: true)
                apply(.playRequested)
            case .seek(let seconds):
                seek(to: seconds)
            }
        }
    }

    private func currentSnapshot() -> PlaybackSnapshot {
        PlaybackSnapshot(
            playing: machine.intendsToPlay,
            position: timeline.position,
            duration: timeline.duration,
            state: machine.state
        )
    }

    /// Report the bound struct back to module state — one `__hypen_bind`
    /// write per changed key, on `<bindPath>.<key>`.
    private func reportPlayback(immediate: Bool) {
        // Muted while suspended (view off-screen / being replaced): stale
        // writes on a shared bind path must never clobber or echo. The
        // resume path re-reports immediately.
        guard reporter != nil, !isSuspended else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let writes = reporter?.writes(
            for: currentSnapshot(), now: now, immediate: immediate
        ) ?? []
        for write in writes {
            dispatcher.dispatch(action: "__hypen_bind", payload: write.payload)
        }
    }

    // MARK: Helpers

    private var currentSrc: String {
        sources.indices.contains(currentIndex)
            ? sources[currentIndex]
            : (sources.first ?? "")
    }

    /// Merge the contract event payload over the action's own payload
    /// (extra keys from grouped-applicator syntax survive; contract keys
    /// win) and hand it to the dispatcher, which serializes it across the
    /// isolation boundary itself.
    private func dispatch(_ action: ActionValue?, _ event: [String: Any]) {
        guard let action = action else { return }
        var payload = action.payload
        for (key, value) in event {
            payload[key] = value
        }
        dispatcher.dispatch(action: action.actionName, payload: payload)
    }

    // MARK: Lifecycle (suspend / resume / runtime config)

    /// The hosting view disappeared. The manager (a `@StateObject`) survives
    /// a disappear/appear cycle — NavigationStack push/pop, TabView switch,
    /// lazy-container culling — so this must NOT tear the player down (the
    /// old `cleanup()` here destroyed the item and observers with no code
    /// path ever restoring them, leaving a permanently dead surface on
    /// reappear). Instead: suspend. The item, observers and position stay
    /// alive; playback pauses so audio never keeps running off-screen —
    /// dispatching `onPause` when it was playing, per the contract's
    /// Detach behaviour ("pauses, dispatching onPause, but keeps its
    /// position and last frame").
    func suspend() {
        guard suspendedPlayIntent == nil else { return }
        suspendedPlayIntent = machine.intendsToPlay
        isSuspended = true
        if machine.intendsToPlay {
            // Dispatches `onPause` (there was a reported play); the bind
            // report is muted — see `isSuspended`.
            requestPause()
        } else {
            player.pause()
        }
    }

    /// The hosting view reappeared after a `suspend()`. Re-arm: resume
    /// playback when it was playing at suspension (contract: re-Attach
    /// "resumes playback, dispatching onPlay, unless the user had paused
    /// it"). Defensive: if the current item was somehow torn down, reload
    /// the current track at the saved position with the saved play intent.
    func resumeIfSuspended() {
        guard let intent = suspendedPlayIntent else { return }
        suspendedPlayIntent = nil
        isSuspended = false
        if player.currentItem == nil {
            let position = timeline.position
            loadTrack(at: currentIndex, playWhenReady: intent, notifyTrackChange: false)
            if position > 0 {
                pendingStartPosition = position
            }
            return
        }
        if intent {
            requestPlay()
        }
        // Re-sync the bind after the muted stretch (reports while suspended
        // were dropped; the reporter's per-key memory makes this a no-op
        // when nothing actually drifted).
        reportPlayback(immediate: true)
    }

    /// Re-apply the identity-independent props to the live player. Runtime
    /// updates to `muted` / `loop` / `autoplay` / the `@actions.*` event
    /// bindings / the `bind` path steer the existing player — they are
    /// deliberately outside the media identity (see `VideoComponent.render`),
    /// so nothing rebuilds for them and they must land imperatively.
    /// Idempotent: called on appear and on every `VideoRuntimeConfig` change.
    func applyRuntimeConfig(_ config: VideoRuntimeConfig) {
        if player.isMuted != config.muted {
            player.isMuted = config.muted
        }
        if queue.loop != config.loop {
            queue = VideoQueue(
                sourceCount: queue.sourceCount,
                isPlaylist: queue.isPlaylist,
                loop: config.loop
            )
        }
        autoplay = config.autoplay
        bindings = config.bindings
        if bindPath != config.bindPath {
            bindPath = config.bindPath
            if let path = config.bindPath, !path.isEmpty {
                // A fresh reporter starts empty, so the next report
                // re-writes every key under the new path immediately.
                reporter = PlaybackBindReporter(path: path)
                reportPlayback(immediate: true)
            } else {
                reporter = nil
            }
        }
    }

    deinit {
        // Final teardown, once SwiftUI releases the @StateObject. A
        // nonisolated deinit may only touch Sendable stored properties, so
        // the player and its periodic observer token are reached through
        // the (Sendable) teardown handle. The Combine cancellables cancel
        // themselves on deallocation.
        teardownHandle.tearDown()
    }
}

// MARK: - Video Player Representable

/// UIViewRepresentable/NSViewRepresentable for displaying video without controls
#if os(iOS) || os(tvOS)
private struct VideoPlayerRepresentable: UIViewRepresentable {
    let player: AVPlayer
    let objectFit: String?

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.player = player
        view.playerLayer.videoGravity = videoGravity(for: objectFit)
        return view
    }

    func updateUIView(_ uiView: PlayerUIView, context: Context) {
        uiView.player = player
        uiView.playerLayer.videoGravity = videoGravity(for: objectFit)
    }
}

private class PlayerUIView: UIView {
    var player: AVPlayer? {
        get { playerLayer.player }
        set { playerLayer.player = newValue }
    }

    var playerLayer: AVPlayerLayer {
        layer as! AVPlayerLayer
    }

    override static var layerClass: AnyClass {
        AVPlayerLayer.self
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        playerLayer.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

/// Maps the contract's `objectFit` values onto AVLayerVideoGravity.
/// contain (default) → resizeAspect, cover → resizeAspectFill,
/// fill → resize.
private func videoGravity(for objectFit: String?) -> AVLayerVideoGravity {
    switch objectFit?.lowercased() {
    case "cover": return .resizeAspectFill
    case "fill": return .resize
    default: return .resizeAspect
    }
}

#elseif os(macOS)
private struct VideoPlayerRepresentable: NSViewRepresentable {
    let player: AVPlayer
    let objectFit: String?

    func makeNSView(context: Context) -> PlayerNSView {
        let view = PlayerNSView()
        view.player = player
        view.setVideoGravity(videoGravity(for: objectFit))
        return view
    }

    func updateNSView(_ nsView: PlayerNSView, context: Context) {
        nsView.player = player
        nsView.setVideoGravity(videoGravity(for: objectFit))
    }
}

private class PlayerNSView: NSView {
    var player: AVPlayer? {
        get { playerLayer?.player }
        set { playerLayer?.player = newValue }
    }

    private var playerLayer: AVPlayerLayer?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupLayer()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupLayer()
    }

    func setVideoGravity(_ gravity: AVLayerVideoGravity) {
        playerLayer?.videoGravity = gravity
    }

    private func setupLayer() {
        wantsLayer = true
        let layer = AVPlayerLayer()
        layer.videoGravity = .resizeAspect
        self.layer = layer
        playerLayer = layer
    }
}

/// Maps the contract's `objectFit` values onto AVLayerVideoGravity.
/// contain (default) → resizeAspect, cover → resizeAspectFill,
/// fill → resize.
private func videoGravity(for objectFit: String?) -> AVLayerVideoGravity {
    switch objectFit?.lowercased() {
    case "cover": return .resizeAspectFill
    case "fill": return .resize
    default: return .resizeAspect
    }
}

#else
// watchOS fallback - just show a placeholder
private struct VideoPlayerRepresentable: View {
    let player: AVPlayer
    let objectFit: String?

    var body: some View {
        Text("Video not supported")
            .foregroundColor(.gray)
    }
}
#endif

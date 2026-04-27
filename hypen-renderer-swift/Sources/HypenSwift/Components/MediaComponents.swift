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

/// Handler for Video components.
/// Uses AVKit's VideoPlayer for video playback.
///
/// Video source is passed as an argument: Video(src: "url")
/// Controls can be enabled: Video(src: "url", controls: true)
/// All styling is done via applicators: Video(src: "url").cornerRadius(12)
public struct VideoComponent: ComponentHandler {
    public let typeName = "video"

    public init() {}

    public func render(
        context: ComponentContext,
        modifier: HypenModifier,
        children: @escaping () -> AnyView
    ) -> AnyView {
        // Video source from props
        let src = context.element.getStringProp("0")
            ?? context.element.getStringProp("src")
            ?? context.element.getStringProp("source")

        // Controls visibility
        let showControls = context.element.getBoolProp("controls")
            ?? context.element.getBoolProp("controls.0")
            ?? false

        // Autoplay
        let autoplay = context.element.getBoolProp("autoplay")
            ?? context.element.getBoolProp("autoplay.0")
            ?? false

        // Loop
        let loop = context.element.getBoolProp("loop")
            ?? context.element.getBoolProp("loop.0")
            ?? false

        // Muted
        let muted = context.element.getBoolProp("muted")
            ?? context.element.getBoolProp("muted.0")
            ?? false

        guard let src = src, let url = URL(string: src) else {
            // No source - render empty box
            return AnyView(
                Color.clear
                    .hypenModifier(modifier)
            )
        }

        return AnyView(
            VideoPlayerView(
                url: url,
                showControls: showControls,
                autoplay: autoplay,
                loop: loop,
                muted: muted
            )
            .hypenModifier(modifier)
        )
    }
}

// MARK: - Video Player View

/// Internal SwiftUI view that manages video playback
private struct VideoPlayerView: View {
    let url: URL
    let showControls: Bool
    let autoplay: Bool
    let loop: Bool
    let muted: Bool

    @StateObject private var playerManager: VideoPlayerManager

    init(url: URL, showControls: Bool, autoplay: Bool, loop: Bool, muted: Bool) {
        self.url = url
        self.showControls = showControls
        self.autoplay = autoplay
        self.loop = loop
        self.muted = muted
        _playerManager = StateObject(wrappedValue: VideoPlayerManager(
            url: url,
            autoplay: autoplay,
            loop: loop,
            muted: muted
        ))
    }

    var body: some View {
        Group {
            if showControls {
                // Use system VideoPlayer with controls
                VideoPlayer(player: playerManager.player)
            } else {
                // Custom player without controls
                VideoPlayerRepresentable(player: playerManager.player)
            }
        }
        .onDisappear {
            playerManager.cleanup()
        }
    }
}

// MARK: - Video Player Manager

/// Observable class that manages AVPlayer for video playback
@MainActor
private class VideoPlayerManager: ObservableObject {
    let player: AVPlayer
    private var cancellables = Set<AnyCancellable>()
    private var loopObserver: Any?

    init(url: URL, autoplay: Bool, loop: Bool, muted: Bool) {
        let playerItem = AVPlayerItem(url: url)
        player = AVPlayer(playerItem: playerItem)
        player.isMuted = muted

        if autoplay {
            // Observe ready state and autoplay
            playerItem.publisher(for: \.status)
                .receive(on: DispatchQueue.main)
                .sink { [weak self] status in
                    Task { @MainActor in
                        if status == .readyToPlay {
                            self?.player.play()
                        }
                    }
                }
                .store(in: &cancellables)
        }

        if loop {
            // Loop when playback ends
            loopObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: playerItem,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.player.seek(to: .zero)
                    self?.player.play()
                }
            }
        }
    }

    func cleanup() {
        player.pause()
        if let observer = loopObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        cancellables.removeAll()
    }

    deinit {
        // Note: cleanup() should be called from onDisappear
    }
}

// MARK: - Video Player Representable

/// UIViewRepresentable/NSViewRepresentable for displaying video without controls
#if os(iOS) || os(tvOS)
private struct VideoPlayerRepresentable: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.player = player
        return view
    }

    func updateUIView(_ uiView: PlayerUIView, context: Context) {
        uiView.player = player
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

#elseif os(macOS)
private struct VideoPlayerRepresentable: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> PlayerNSView {
        let view = PlayerNSView()
        view.player = player
        return view
    }

    func updateNSView(_ nsView: PlayerNSView, context: Context) {
        nsView.player = player
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

    private func setupLayer() {
        wantsLayer = true
        let layer = AVPlayerLayer()
        layer.videoGravity = .resizeAspect
        self.layer = layer
        playerLayer = layer
    }
}

#else
// watchOS fallback - just show a placeholder
private struct VideoPlayerRepresentable: View {
    let player: AVPlayer

    var body: some View {
        Text("Video not supported")
            .foregroundColor(.gray)
    }
}
#endif

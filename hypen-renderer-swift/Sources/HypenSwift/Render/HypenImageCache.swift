import SwiftUI

#if canImport(UIKit)
import UIKit
public typealias HypenPlatformImage = UIImage
#elseif canImport(AppKit)
import AppKit
public typealias HypenPlatformImage = NSImage
#endif

/// Process-wide image cache for Hypen's remote image rendering.
///
/// SwiftUI's `AsyncImage` does not cache decoded images. Every time the
/// view re-composes (which Hypen does on every patch batch — see
/// `HypenRenderer.treeVersion`), `AsyncImage` returns to its `.empty`
/// phase, kicks off a fresh URL load, and decodes the bytes again.
/// Against a feed full of Unsplash-sized photos this produces the
/// "images constantly reload" symptom.
///
/// `HypenImageCache` memoizes fully-decoded `UIImage` / `NSImage`
/// instances in an `NSCache` keyed by URL. On cache hit the view renders
/// the decoded image synchronously — no flash, no network, no decode
/// cost. On cache miss we fall through to `URLSession.shared`, which
/// consults `URLCache.shared` for HTTP-level caching (honors
/// `Cache-Control`). Both layers are process-global and survive across
/// patches, navigations, and `HypenElementView` rebuilds.
///
/// The cache auto-bootstraps `URLCache.shared` on first access with
/// generous sizing (50 MB memory / 500 MB disk) — larger than the
/// default 4 MB / 20 MB that most apps run under, which is typically
/// overflowed by a single social feed. An app that owns `URLCache.shared`
/// for its own reasons can set it before the first image loads and this
/// bootstrap becomes a no-op.
@MainActor
public final class HypenImageCache {
    public static let shared = HypenImageCache()

    private let cache: NSCache<NSString, HypenPlatformImage> = {
        let c = NSCache<NSString, HypenPlatformImage>()
        // Budget by entry count AND approximate byte count. We don't know
        // exact bitmap size without decoding, but the count cap prevents
        // unbounded growth on very-long sessions.
        c.countLimit = 256
        c.totalCostLimit = 100 * 1024 * 1024 // ~100 MB
        return c
    }()

    // In-flight downloads yield raw `Data` — decoding happens on the
    // MainActor so we never ship a non-Sendable platform image across
    // an actor boundary (NSImage is only Sendable on macOS 14+).
    private var inflight: [String: Task<Data?, Never>] = [:]

    private init() {
        // Bootstrap URLCache.shared if the host app hasn't configured one
        // larger than the ~4 MB / 20 MB default. Enlarging (not shrinking)
        // is safe even if the app already set a custom cache.
        let existing = URLCache.shared
        let desiredMemory = 50 * 1024 * 1024
        let desiredDisk = 500 * 1024 * 1024
        if existing.memoryCapacity < desiredMemory || existing.diskCapacity < desiredDisk {
            URLCache.shared = URLCache(
                memoryCapacity: max(existing.memoryCapacity, desiredMemory),
                diskCapacity: max(existing.diskCapacity, desiredDisk),
                diskPath: nil
            )
        }

        // Evict memory-cached images under pressure. We deliberately don't
        // purge on backgrounding because the whole point is surviving the
        // next activation.
        #if canImport(UIKit)
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.cache.removeAllObjects()
        }
        #endif
    }

    public func cached(for url: URL) -> HypenPlatformImage? {
        cache.object(forKey: url.absoluteString as NSString)
    }

    /// Fetch (cache or network) the decoded image for `url`.
    ///
    /// Concurrent calls for the same URL share one in-flight download so
    /// we never fire duplicate requests for the same image. The detached
    /// task returns `Data` (Sendable); decoding happens on the MainActor
    /// so `NSImage` / `UIImage` never cross actor boundaries.
    public func load(url: URL) async -> HypenPlatformImage? {
        let key = url.absoluteString
        if let hit = cache.object(forKey: key as NSString) {
            return hit
        }
        let data: Data?
        if let existing = inflight[key] {
            data = await existing.value
        } else {
            let task = Task<Data?, Never> {
                (try? await URLSession.shared.data(from: url))?.0
            }
            inflight[key] = task
            data = await task.value
            inflight[key] = nil
        }
        guard let data = data else { return nil }
        #if canImport(UIKit)
        guard let image = UIImage(data: data) else { return nil }
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale) * 4
        #else
        guard let image = NSImage(data: data) else { return nil }
        let cost = Int(image.size.width * image.size.height) * 4
        #endif
        cache.setObject(image, forKey: key as NSString, cost: max(cost, 1))
        return image
    }
}

/// A caching replacement for `AsyncImage` that reads/writes through
/// `HypenImageCache`.
///
/// Renders synchronously on cache hit (no network, no decode, no layout
/// flash). On cache miss it shows `placeholder` while loading, then
/// stores the decoded image in the cache for all future renders.
@MainActor
public struct HypenCachedImage<Placeholder: View, Failure: View>: View {
    private let url: URL?
    private let placeholder: () -> Placeholder
    private let failure: () -> Failure
    private let transform: (Image) -> AnyView

    @State private var image: HypenPlatformImage?
    @State private var failed: Bool = false

    public init(
        url: URL?,
        @ViewBuilder placeholder: @escaping () -> Placeholder,
        @ViewBuilder failure: @escaping () -> Failure,
        transform: @escaping (Image) -> AnyView = { AnyView($0) }
    ) {
        self.url = url
        self.placeholder = placeholder
        self.failure = failure
        self.transform = transform
        // Prime synchronously from the cache so we avoid a one-frame
        // placeholder flash when the URL is already resident.
        if let url = url, let cached = HypenImageCache.shared.cached(for: url) {
            _image = State(initialValue: cached)
        }
    }

    public var body: some View {
        content
            .task(id: url?.absoluteString) {
                guard let url = url else { return }
                if image != nil { return }
                failed = false
                if let fetched = await HypenImageCache.shared.load(url: url) {
                    image = fetched
                } else {
                    failed = true
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let image = image {
            #if canImport(UIKit)
            transform(Image(uiImage: image))
            #else
            transform(Image(nsImage: image))
            #endif
        } else if failed {
            failure()
        } else {
            placeholder()
        }
    }
}

import SwiftUI
import ImageIO

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
/// `HypenImageCache` memoizes pre-decoded `UIImage` / `NSImage`
/// instances in an `NSCache` keyed by URL and requested pixel size. On cache hit the view renders
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

    /// Conservative display bound for fill-sized images whose parent has not
    /// provided a numeric width or height (for example a full-screen story).
    public static var displayBounds: CGSize {
        #if canImport(UIKit)
        UIScreen.main.bounds.size
        #elseif canImport(AppKit)
        NSScreen.main?.visibleFrame.size ?? .zero
        #else
        .zero
        #endif
    }

    private let cache: NSCache<NSString, HypenPlatformImage> = {
        let c = NSCache<NSString, HypenPlatformImage>()
        // Budget by entry count AND approximate byte count. We don't know
        // exact bitmap size without decoding, but the count cap prevents
        // unbounded growth on very-long sessions.
        c.countLimit = 256
        c.totalCostLimit = 100 * 1024 * 1024 // ~100 MB
        return c
    }()

    // Downloads are shared by URL even when callers need different decoded sizes.
    // ImageIO returns a Sendable CGImage from the detached decode task; only
    // the cheap UIImage/NSImage wrapper is made on the MainActor.
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

    public func cached(for url: URL, targetSize: CGSize? = nil, scale: CGFloat = 1) -> HypenPlatformImage? {
        let request = HypenImageDecodeRequest(targetSize: targetSize, scale: scale)
        return cache.object(forKey: request.cacheKey(for: url) as NSString)
    }

    /// Fetch (cache or network) the decoded image for `url`.
    ///
    /// Concurrent calls for the same URL share one download. ImageIO creates
    /// and decodes a size-appropriate CGImage off the main actor, so SwiftUI's
    /// first draw does not inherit the compressed image's decode work.
    public func load(url: URL, targetSize: CGSize? = nil, scale: CGFloat = 1) async -> HypenPlatformImage? {
        let request = HypenImageDecodeRequest(targetSize: targetSize, scale: scale)
        let cacheKey = request.cacheKey(for: url)
        if let hit = cache.object(forKey: cacheKey as NSString) {
            return hit
        }
        let key = url.absoluteString
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
        let decoded = await Task.detached(priority: .utility) {
            HypenImageDecoder.decode(data: data, request: request)
        }.value
        guard let decoded, !Task.isCancelled else { return nil }
        #if canImport(UIKit)
        let image = UIImage(cgImage: decoded)
        #else
        let image = NSImage(cgImage: decoded, size: .zero)
        #endif
        let cost = decoded.bytesPerRow * decoded.height
        cache.setObject(image, forKey: cacheKey as NSString, cost: max(cost, 1))
        return image
    }
}

struct HypenImageDecodeRequest: Hashable, Sendable {
    let pixelWidth: Int
    let pixelHeight: Int

    init(targetSize: CGSize?, scale: CGFloat) {
        let safeScale = scale.isFinite && scale > 0 ? scale : 1
        func pixels(_ points: CGFloat?) -> Int {
            guard let points, points.isFinite, points > 0 else { return 0 }
            return max(1, min(8192, Int(min(points * safeScale, 8192).rounded(.up))))
        }
        pixelWidth = pixels(targetSize?.width)
        pixelHeight = pixels(targetSize?.height)
    }

    func cacheKey(for url: URL) -> String {
        "\(pixelWidth)x\(pixelHeight):\(url.absoluteString)"
    }
}

enum HypenImageDecoder {
    static func decode(data: Data, request: HypenImageDecodeRequest) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let immediate = [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        guard request.pixelWidth > 0 || request.pixelHeight > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let sourceWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let sourceHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              sourceWidth > 0, sourceHeight > 0 else {
            return CGImageSourceCreateImageAtIndex(source, 0, immediate)
        }

        // Use the larger axis ratio so cover/crop layouts retain enough pixels
        // in both dimensions. A one-axis constraint uses the source aspect ratio.
        let ratio = min(1, max(
            Double(request.pixelWidth) / Double(sourceWidth),
            Double(request.pixelHeight) / Double(sourceHeight)
        ))
        let maxPixelSize = max(1, Int(ceil(Double(max(sourceWidth, sourceHeight)) * ratio)))
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
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
    @Environment(\.displayScale) private var displayScale

    private let url: URL?
    private let targetSize: CGSize?
    private let placeholder: () -> Placeholder
    private let failure: () -> Failure
    private let transform: (Image) -> AnyView

    @State private var image: HypenPlatformImage?
    @State private var imageKey: String?
    @State private var failedKey: String?

    public init(
        url: URL?,
        targetSize: CGSize? = nil,
        @ViewBuilder placeholder: @escaping () -> Placeholder,
        @ViewBuilder failure: @escaping () -> Failure,
        transform: @escaping (Image) -> AnyView = { AnyView($0) }
    ) {
        self.url = url
        self.targetSize = targetSize
        self.placeholder = placeholder
        self.failure = failure
        self.transform = transform
    }

    private var requestKey: String? {
        guard let url else { return nil }
        return HypenImageDecodeRequest(targetSize: targetSize, scale: displayScale).cacheKey(for: url)
    }

    private var displayedImage: HypenPlatformImage? {
        guard let url, let requestKey else { return nil }
        if imageKey == requestKey { return image }
        return HypenImageCache.shared.cached(for: url, targetSize: targetSize, scale: displayScale)
    }

    public var body: some View {
        content
            .task(id: requestKey) {
                guard let url = url else { return }
                if displayedImage != nil { return }
                image = nil
                imageKey = nil
                failedKey = nil
                if let fetched = await HypenImageCache.shared.load(url: url, targetSize: targetSize, scale: displayScale) {
                    guard !Task.isCancelled else { return }
                    image = fetched
                    imageKey = requestKey
                } else {
                    guard !Task.isCancelled else { return }
                    failedKey = requestKey
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let image = displayedImage {
            #if canImport(UIKit)
            transform(Image(uiImage: image))
            #else
            transform(Image(nsImage: image))
            #endif
        } else if failedKey == requestKey {
            failure()
        } else {
            placeholder()
        }
    }
}

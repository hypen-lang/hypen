import Foundation
import ImageIO
import Testing
@testable import HypenSwift
#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Manual measurement for audit finding iOS #4: what constructing and
/// decoding an image on the main actor costs (`HypenImageCache.load` builds
/// the platform image on the MainActor after the bytes arrive). Run with
/// `HYPEN_PERF=1 swift test --filter ImageDecodePerfTests`.
@MainActor
@Suite("Image decode cost (manual perf)")
struct ImageDecodePerfTests {
    nonisolated private static var enabled: Bool { ProcessInfo.processInfo.environment["HYPEN_PERF"] != nil }

    /// A JPEG of `w` × `h` with enough detail that the decoder does real work.
    private func jpeg(_ w: Int, height h: Int) -> Data {
        let cs = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        for i in 0..<64 {
            ctx.setFillColor(CGColor(red: CGFloat(i % 7) / 7, green: CGFloat(i % 5) / 5, blue: CGFloat(i % 3) / 3, alpha: 1))
            ctx.fillEllipse(in: CGRect(x: Double(i * 13 % w), y: Double(i * 29 % h), width: Double(w / 4), height: Double(h / 4)))
        }
        let image = ctx.makeImage()!
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        CGImageDestinationFinalize(dest)
        return data as Data
    }

    private func measure(_ runs: Int, _ body: () -> Void) -> (median: Double, max: Double) {
        var samples: [Double] = []
        for _ in 0..<runs {
            let t = DispatchTime.now().uptimeNanoseconds
            body()
            samples.append(Double(DispatchTime.now().uptimeNanoseconds - t) / 1_000_000)
        }
        samples.sort()
        return (samples[samples.count / 2], samples.last!)
    }

    @Test(.enabled(if: enabled)) func decodeCostPerImage() {
        for (label, w, h) in [("thumbnail 400x400", 400, 400), ("card 1080x720", 1080, 720), ("story 1080x1920", 1080, 1920)] {
            let data = jpeg(w, height: h)
            // What `HypenImageCache.load` does on the MainActor today.
            let construct = measure(20) {
                #if canImport(UIKit)
                _ = UIImage(data: data)
                #else
                _ = NSImage(data: data)
                #endif
            }
            // The decode the first draw then forces, on the main thread.
            let forced = measure(20) {
                let src = CGImageSourceCreateWithData(data as CFData, nil)!
                let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: true] as CFDictionary)!
                let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
            }
            // Downsampled decode (ImageIO thumbnail at display size): the
            // shape an off-main-actor pre-decode would take.
            let downsampled = measure(20) {
                let src = CGImageSourceCreateWithData(data as CFData, nil)!
                let opts = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceThumbnailMaxPixelSize: 400,
                            kCGImageSourceShouldCacheImmediately: true] as CFDictionary
                _ = CGImageSourceCreateThumbnailAtIndex(src, 0, opts)
            }
            print(String(format: "[perf] %@ (%d KB jpeg): construct %.3f ms (max %.3f) | full decode+draw %.2f ms (max %.2f) | downsampled decode %.2f ms (max %.2f)",
                         label, data.count / 1024, construct.median, construct.max, forced.median, forced.max, downsampled.median, downsampled.max))
        }
    }
}

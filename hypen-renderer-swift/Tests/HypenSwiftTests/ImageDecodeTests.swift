import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import HypenSwift

@Suite("Remote image decoding")
struct ImageDecodeTests {
    @Test func downsamplingUsesDisplayPixelsAndPreservesAspectRatio() throws {
        let data = try imageData(width: 200, height: 100)
        let request = HypenImageDecodeRequest(targetSize: CGSize(width: 40, height: 0), scale: 2)
        let decoded = try #require(HypenImageDecoder.decode(data: data, request: request))

        #expect(decoded.width == 80)
        #expect(decoded.height == 40)
    }

    @Test func unconstrainedImageRetainsItsIntrinsicSize() throws {
        let data = try imageData(width: 200, height: 100)
        let request = HypenImageDecodeRequest(targetSize: nil, scale: 2)
        let decoded = try #require(HypenImageDecoder.decode(data: data, request: request))

        #expect(decoded.width == 200)
        #expect(decoded.height == 100)
    }

    @Test func cacheSeparatesDisplaySizesForTheSameURL() throws {
        let url = try #require(URL(string: "https://example.com/image.png"))
        let small = HypenImageDecodeRequest(targetSize: CGSize(width: 40, height: 40), scale: 2)
        let large = HypenImageDecodeRequest(targetSize: CGSize(width: 100, height: 100), scale: 2)

        #expect(small.cacheKey(for: url) != large.cacheKey(for: url))
    }

    private func imageData(width: Int, height: Int) throws -> Data {
        let context = try #require(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let bytes = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return bytes as Data
    }
}

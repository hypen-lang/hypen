import Foundation
import XCTest
@testable import HypenServer

// Shared helpers for the device-protocol conformance tests (which run the
// shared corpus through the runtime path: RemoteSession routing and the Rust
// broker through `DevicePlane`).
//
// Fixtures are read with a small lenient JSON reader that keeps the exact
// source bytes of every value (`FixtureJSON.raw`). A `message` / `value`
// case therefore reaches the broker as exactly the text the fixture spells —
// never through a `JSONSerialization` round trip, which would collapse
// number spellings (`1.0` → `1`) and duplicate keys first. Duplicate keys
// anywhere in a fixture file are fixture errors.

enum DeviceFixtures {
    /// `hypen-server-swift/Tests/HypenServerTests/<this file>` → repo root.
    static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // HypenServerTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // hypen-server-swift
            .deletingLastPathComponent()  // repo root
    }

    static var directory: URL {
        repoRoot.appendingPathComponent("engine-compatibility-tests/fixtures/device")
    }

    /// Fixtures ship with the repository: a standalone package checkout
    /// (no `engine-compatibility-tests/`) skips, a repo checkout never does.
    static func requireDirectory() throws -> URL {
        let url = directory
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("device fixtures not present at \(url.path) (standalone checkout)")
        }
        return url
    }

    static func load(_ relative: String) throws -> FixtureJSON {
        _ = try requireDirectory()
        let url = repoRoot.appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail("shared fixture missing: \(relative)")
            throw FixtureError("missing \(relative)")
        }
        return try FixtureJSON.parse(Data(contentsOf: url))
    }
}

struct FixtureError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// A fixture JSON value plus its exact source bytes.
final class FixtureJSON {
    enum Kind {
        case null
        case bool(Bool)
        /// The number token as spelled.
        case number(String)
        /// Decoded string contents as UTF-8 bytes (may hold any code point).
        case string([UInt8])
        case array([FixtureJSON])
        case object([(String, FixtureJSON)])
    }

    let kind: Kind
    let raw: Data

    init(kind: Kind, raw: Data) {
        self.kind = kind
        self.raw = raw
    }

    subscript(key: String) -> FixtureJSON? {
        guard case let .object(members) = kind else { return nil }
        return members.first { $0.0 == key }?.1
    }

    var keys: [String] {
        guard case let .object(members) = kind else { return [] }
        return members.map { $0.0 }
    }

    var isNull: Bool {
        if case .null = kind { return true }
        return false
    }

    var bool: Bool? {
        if case let .bool(flag) = kind { return flag }
        return nil
    }

    var bytes: [UInt8]? {
        if case let .string(bytes) = kind { return bytes }
        return nil
    }

    var string: String? { bytes.map { String(decoding: $0, as: UTF8.self) } }

    var uint64: UInt64? {
        if case let .number(token) = kind { return UInt64(token) }
        return nil
    }

    var int: Int? {
        if case let .number(token) = kind { return Int(token) }
        return nil
    }

    var array: [FixtureJSON]? {
        if case let .array(items) = kind { return items }
        return nil
    }

    var u32s: [UInt32]? { array?.compactMap { $0.uint64.flatMap { UInt32(exactly: $0) } } }

    static func parse(_ data: Data) throws -> FixtureJSON {
        var reader = Reader(bytes: [UInt8](data))
        reader.skipWhitespace()
        let value = try reader.value()
        reader.skipWhitespace()
        guard reader.index == reader.bytes.count else { throw FixtureError("fixture: trailing data") }
        return value
    }

    private struct Reader {
        let bytes: [UInt8]
        var index = 0

        init(bytes: [UInt8]) { self.bytes = bytes }

        mutating func skipWhitespace() {
            while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
        }

        mutating func value() throws -> FixtureJSON {
            guard index < bytes.count else { throw FixtureError("fixture: unexpected end") }
            let start = index
            let kind: Kind
            switch bytes[index] {
            case UInt8(ascii: "{"):
                index += 1
                var members: [(String, FixtureJSON)] = []
                skipWhitespace()
                if bytes[index] == UInt8(ascii: "}") {
                    index += 1
                } else {
                    while true {
                        skipWhitespace()
                        let key = String(decoding: try string(), as: UTF8.self)
                        guard !members.contains(where: { $0.0 == key }) else {
                            throw FixtureError("fixture: duplicate key '\(key)'")
                        }
                        skipWhitespace()
                        try expect(UInt8(ascii: ":"))
                        skipWhitespace()
                        members.append((key, try value()))
                        skipWhitespace()
                        let next = bytes[index]
                        index += 1
                        if next == UInt8(ascii: "}") { break }
                        guard next == UInt8(ascii: ",") else { throw FixtureError("fixture: expected , or }") }
                    }
                }
                kind = .object(members)
            case UInt8(ascii: "["):
                index += 1
                var items: [FixtureJSON] = []
                skipWhitespace()
                if bytes[index] == UInt8(ascii: "]") {
                    index += 1
                } else {
                    while true {
                        skipWhitespace()
                        items.append(try value())
                        skipWhitespace()
                        let next = bytes[index]
                        index += 1
                        if next == UInt8(ascii: "]") { break }
                        guard next == UInt8(ascii: ",") else { throw FixtureError("fixture: expected , or ]") }
                    }
                }
                kind = .array(items)
            case UInt8(ascii: "\""):
                kind = .string(try string())
            case UInt8(ascii: "t"):
                try word("true"); kind = .bool(true)
            case UInt8(ascii: "f"):
                try word("false"); kind = .bool(false)
            case UInt8(ascii: "n"):
                try word("null"); kind = .null
            default:
                let tokenStart = index
                while index < bytes.count, "+-.eE0123456789".utf8.contains(bytes[index]) { index += 1 }
                guard index > tokenStart else { throw FixtureError("fixture: unexpected byte") }
                kind = .number(String(decoding: bytes[tokenStart..<index], as: UTF8.self))
            }
            return FixtureJSON(kind: kind, raw: Data(bytes[start..<index]))
        }

        mutating func expect(_ byte: UInt8) throws {
            guard index < bytes.count, bytes[index] == byte else { throw FixtureError("fixture: expected \(Character(Unicode.Scalar(byte)))") }
            index += 1
        }

        mutating func word(_ literal: String) throws {
            for byte in literal.utf8 { try expect(byte) }
        }

        mutating func hex4() throws -> UInt32 {
            guard index + 4 <= bytes.count,
                  let value = UInt32(String(decoding: bytes[index..<(index + 4)], as: UTF8.self), radix: 16) else {
                throw FixtureError("fixture: bad \\u escape")
            }
            index += 4
            return value
        }

        mutating func string() throws -> [UInt8] {
            try expect(UInt8(ascii: "\""))
            var out: [UInt8] = []
            while true {
                guard index < bytes.count else { throw FixtureError("fixture: unterminated string") }
                let b = bytes[index]
                index += 1
                if b == UInt8(ascii: "\"") { return out }
                guard b == UInt8(ascii: "\\") else {
                    out.append(b)
                    continue
                }
                let e = bytes[index]
                index += 1
                switch e {
                case UInt8(ascii: "n"): out.append(0x0A)
                case UInt8(ascii: "t"): out.append(0x09)
                case UInt8(ascii: "r"): out.append(0x0D)
                case UInt8(ascii: "b"): out.append(0x08)
                case UInt8(ascii: "f"): out.append(0x0C)
                case UInt8(ascii: "u"):
                    var scalar = try hex4()
                    if (0xD800...0xDBFF).contains(scalar) {
                        try expect(UInt8(ascii: "\\"))
                        try expect(UInt8(ascii: "u"))
                        let low = try hex4()
                        scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
                    }
                    guard let resolved = Unicode.Scalar(scalar) else {
                        throw FixtureError("fixture: lone surrogate in a fixture string")
                    }
                    out.append(contentsOf: Array(String(Character(resolved)).utf8))
                default: out.append(e)
                }
            }
        }
    }
}

// MARK: - Bytes

func hexDecode(_ hex: String) throws -> Data {
    guard hex.count % 2 == 0 else { throw FixtureError("odd-length hex") }
    var out = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        guard let byte = UInt8(hex[index..<next], radix: 16) else {
            throw FixtureError("invalid hex byte '\(hex[index..<next])'")
        }
        out.append(byte)
        index = next
    }
    return out
}

func hexEncode<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
    bytes.map { String(format: "%02x", $0) }.joined()
}

/// The exact text bytes of a conformance case: `message` / `value` (their
/// fixture spelling), `raw`, `rawHex` or `rawRepeat`.
func caseBytes(_ entry: FixtureJSON) throws -> Data {
    let forms = ["message", "value", "raw", "rawHex", "rawRepeat"].filter { entry[$0] != nil }
    guard forms.count == 1, let form = forms.first else {
        throw FixtureError("case must carry exactly one text form, has \(forms)")
    }
    switch form {
    case "raw":
        guard let bytes = entry["raw"]?.bytes else { throw FixtureError("raw is JSON text") }
        return Data(bytes)
    case "rawHex":
        guard let hex = entry["rawHex"]?.string else { throw FixtureError("rawHex is a string") }
        return try hexDecode(hex)
    case "rawRepeat":
        guard let spec = entry["rawRepeat"], let prefix = spec["prefix"]?.bytes, let unit = spec["repeat"]?.bytes,
              let count = spec["count"]?.int, let suffix = spec["suffix"]?.bytes else {
            throw FixtureError("rawRepeat needs prefix/repeat/count/suffix")
        }
        var out = Data(prefix)
        out.reserveCapacity(prefix.count + unit.count * count + suffix.count)
        for _ in 0..<count { out.append(contentsOf: unit) }
        out.append(contentsOf: suffix)
        return out
    default:
        return entry[form]!.raw
    }
}

// MARK: - SHA-256 (FIPS 180-4), for verifying transcript item hashes

func sha256Hex(_ message: [UInt8]) -> String {
    let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]
    var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    var data = message
    let bitLength = UInt64(message.count) * 8
    data.append(0x80)
    while data.count % 64 != 56 { data.append(0) }
    for shift in stride(from: 56, through: 0, by: -8) { data.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift))) }
    func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
    var w = [UInt32](repeating: 0, count: 64)
    for chunk in stride(from: 0, to: data.count, by: 64) {
        for i in 0..<16 {
            let j = chunk + i * 4
            w[i] = UInt32(data[j]) << 24 | UInt32(data[j + 1]) << 16 | UInt32(data[j + 2]) << 8 | UInt32(data[j + 3])
        }
        for i in 16..<64 {
            let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
            let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
            w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
        }
        var (a, b, c, d, e, f, g, hh) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7])
        for i in 0..<64 {
            let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
            let ch = (e & f) ^ (~e & g)
            let t1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
            let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
            let maj = (a & b) ^ (a & c) ^ (b & c)
            let t2 = s0 &+ maj
            (hh, g, f, e, d, c, b, a) = (g, f, e, d &+ t1, c, b, a, t1 &+ t2)
        }
        h = [h[0] &+ a, h[1] &+ b, h[2] &+ c, h[3] &+ d, h[4] &+ e, h[5] &+ f, h[6] &+ g, h[7] &+ hh]
    }
    return h.map { String(format: "%08x", $0) }.joined()
}

// MARK: - Serialization (for feeding fixture messages to the broker)

extension FixtureJSON {
    /// JSON text of this value: object keys sorted by bytes, numbers as
    /// spelled in the fixture, strings re-escaped minimally. `override`
    /// may replace the value at a key path (e.g. `["id"]`,
    /// `["control", "leaseAck"]`) with raw JSON text.
    func text(override: ([String]) -> String? = { _ in nil }) -> String {
        var out: [UInt8] = []
        write(into: &out, path: [], override: override)
        return String(decoding: out, as: UTF8.self)
    }

    private func write(into out: inout [UInt8], path: [String], override: ([String]) -> String?) {
        if !path.isEmpty, let replaced = override(path) {
            out.append(contentsOf: Array(replaced.utf8))
            return
        }
        switch kind {
        case .null: out.append(contentsOf: Array("null".utf8))
        case .bool(let b): out.append(contentsOf: Array((b ? "true" : "false").utf8))
        case .number(let token): out.append(contentsOf: Array(token.utf8))
        case .string(let bytes): FixtureJSON.writeString(bytes, into: &out)
        case .array(let items):
            out.append(UInt8(ascii: "["))
            for (i, item) in items.enumerated() {
                if i > 0 { out.append(UInt8(ascii: ",")) }
                item.write(into: &out, path: path + ["\(i)"], override: override)
            }
            out.append(UInt8(ascii: "]"))
        case .object(let members):
            out.append(UInt8(ascii: "{"))
            let sorted = members.sorted { Array($0.0.utf8).lexicographicallyPrecedes(Array($1.0.utf8)) }
            for (i, (key, value)) in sorted.enumerated() {
                if i > 0 { out.append(UInt8(ascii: ",")) }
                FixtureJSON.writeString(Array(key.utf8), into: &out)
                out.append(UInt8(ascii: ":"))
                value.write(into: &out, path: path + [key], override: override)
            }
            out.append(UInt8(ascii: "}"))
        }
    }

    private static func writeString(_ bytes: [UInt8], into out: inout [UInt8]) {
        out.append(UInt8(ascii: "\""))
        for b in bytes {
            switch b {
            case UInt8(ascii: "\""): out.append(contentsOf: [0x5C, 0x22])
            case UInt8(ascii: "\\"): out.append(contentsOf: [0x5C, 0x5C])
            case 0x00..<0x20: out.append(contentsOf: Array(String(format: "\\u%04x", Int(b)).utf8))
            default: out.append(b)
            }
        }
        out.append(UInt8(ascii: "\""))
    }
}

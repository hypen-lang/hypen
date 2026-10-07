import Foundation

// Device Capability Protocol — strict JSON layer (RFC 001 §2.1 "JSON
// limits", decision D4). Same rules as
// `hypen-server-swift/.../Device/DeviceStrictJSON.swift` (the renderer
// package cannot depend on the server package).
//
// Every inbound device-plane text (envelope messages, `sessionAck.device`,
// capability payloads) is parsed here, and ONLY here: the typed decoders read
// the resulting `DeviceJSON` tree through `DeviceJSONTreeDecoder` below and
// never see raw bytes. `JSONDecoder` is not on the device input path: on
// Swift 6.0.3 FoundationEssentials (and the swift-foundation JSONDecoder of
// iOS 17+) it `try!`s object keys it has not validated, so one malformed key
// — a raw control character, a lone surrogate escape, an invalid UTF-8 byte
// — would kill the process instead of throwing.
//
// The parser is a complete RFC 8259 validator plus the shared device limits,
// applied to keys and values at every depth:
//
// - at most `maxMessageBytes` (1 MiB) of UTF-8 text, checked before parsing;
// - nesting depth at most `maxDepth` (32) containers (`{` or `[`; scalars do
//   not count; the top-level object is depth 1); 33 is rejected;
// - numbers are integer tokens only (`-?(0|[1-9][0-9]*)`): no fraction, no
//   exponent, no `-0`, at most 16 digits, magnitude at most 2^53 − 1. A
//   million-digit token is refused after 17 digits, without a big-number
//   parse;
// - strings are well-formed UTF-8 (no overlongs, no encoded surrogates, no
//   truncated sequences), contain no raw control character (< 0x20) and no
//   unpaired surrogate escape;
// - duplicate object keys are rejected at any depth, compared after
//   unescaping and by exact bytes. Two keys that are byte-distinct but
//   canonically equivalent (`"é"` / `"e\u{301}"`) cannot both be held by a
//   Swift `String`-keyed object, so such an object is refused as malformed
//   rather than silently merged (every v1 schema key is ASCII, so no valid
//   message is affected);
// - only the literals `true`, `false`, `null`; no BOM; no trailing data.

/// Raw-text violations found while parsing a device message.
public enum DeviceStrictJSONError: Error, Equatable, Sendable, CustomStringConvertible {
    /// An object repeats a key (after escape resolution, compared by bytes).
    case duplicateKey(String)
    /// Objects/arrays nest deeper than `DeviceStrictJSON.maxDepth`.
    case tooDeep
    /// The text is larger than `DeviceStrictJSON.maxMessageBytes`.
    case tooLarge
    /// A number that is not an integer token within the device bounds.
    case invalidNumber(String)
    /// A string that is not well-formed UTF-8, holds a raw control
    /// character, or has an invalid / unpaired surrogate escape.
    case invalidString(String)
    /// Not well-formed JSON.
    case malformed(String)

    public var description: String {
        switch self {
        case let .duplicateKey(key): return "duplicate key '\(key)'"
        case .tooDeep: return "JSON nesting exceeds \(DeviceStrictJSON.maxDepth) containers"
        case .tooLarge: return "device message larger than \(DeviceStrictJSON.maxMessageBytes) bytes"
        case let .invalidNumber(detail): return "invalid number: \(detail)"
        case let .invalidString(detail): return "invalid string: \(detail)"
        case let .malformed(detail): return "malformed JSON: \(detail)"
        }
    }
}

public enum DeviceStrictJSON {
    /// Largest device text message, in UTF-8 bytes, checked before parsing.
    public static let maxMessageBytes = 1_048_576
    /// Deepest container nesting (`{` or `[`); the top-level object is depth 1.
    public static let maxDepth = 32
    /// Largest integer magnitude (2^53 − 1); field schemas are tighter.
    public static let maxIntegerMagnitude: UInt64 = 9_007_199_254_740_991
    /// Longest integer token (2^53 − 1 has 16 digits).
    public static let maxIntegerDigits = 16

    /// Parse one device text message under the JSON limits. Numbers come
    /// back as `.int` only (never `.double`).
    public static func parse(_ data: Data) throws -> DeviceJSON {
        guard data.count <= maxMessageBytes else { throw DeviceStrictJSONError.tooLarge }
        return try data.withUnsafeBytes { raw in
            var parser = Parser(bytes: raw.bindMemory(to: UInt8.self))
            return try parser.document()
        }
    }

    /// `parse(_:)` over the UTF-8 encoding of `text`.
    public static func parse(_ text: String) throws -> DeviceJSON {
        try parse(Data(text.utf8))
    }

    /// Throws when `data` breaks any JSON limit (the parse result is dropped).
    public static func check(_ data: Data) throws {
        _ = try parse(data)
    }

    /// Trusted local documents only (test fixtures, never peer input): the
    /// same well-formedness and duplicate-key rules, without the size, depth
    /// and integer-token limits (non-integers become `.double`).
    static func parseTrusted(_ data: Data) throws -> DeviceJSON {
        try data.withUnsafeBytes { raw in
            var parser = Parser(bytes: raw.bindMemory(to: UInt8.self), trusted: true)
            return try parser.document()
        }
    }

    struct Parser {
        let bytes: UnsafeBufferPointer<UInt8>
        let trusted: Bool
        var index = 0
        var depth = 0

        init(bytes: UnsafeBufferPointer<UInt8>, trusted: Bool = false) {
            self.bytes = bytes
            self.trusted = trusted
        }

        mutating func document() throws -> DeviceJSON {
            skipWhitespace()
            let value = try self.value()
            skipWhitespace()
            guard index == bytes.count else { throw DeviceStrictJSONError.malformed("trailing data") }
            return value
        }

        private mutating func skipWhitespace() {
            while index < bytes.count {
                switch bytes[index] {
                case 0x20, 0x09, 0x0A, 0x0D: index += 1
                default: return
                }
            }
        }

        private func peek() throws -> UInt8 {
            guard index < bytes.count else { throw DeviceStrictJSONError.malformed("unexpected end") }
            return bytes[index]
        }

        private mutating func value() throws -> DeviceJSON {
            switch try peek() {
            case UInt8(ascii: "{"): return try object()
            case UInt8(ascii: "["): return try array()
            case UInt8(ascii: "\""): return .string(String(decoding: try string(), as: UTF8.self))
            case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
                return trusted ? try trustedNumber() : .int(try number())
            case UInt8(ascii: "t"): try literal("true"); return .bool(true)
            case UInt8(ascii: "f"): try literal("false"); return .bool(false)
            case UInt8(ascii: "n"): try literal("null"); return .null
            default: throw DeviceStrictJSONError.malformed("unexpected byte 0x\(String(bytes[index], radix: 16))")
            }
        }

        private mutating func enter() throws {
            depth += 1
            if depth > DeviceStrictJSON.maxDepth, !trusted { throw DeviceStrictJSONError.tooDeep }
        }

        /// Any RFC 8259 number (trusted documents only).
        private mutating func trustedNumber() throws -> DeviceJSON {
            let start = index
            while index < bytes.count {
                let b = bytes[index]
                guard Self.isDigit(b) || b == UInt8(ascii: "-") || b == UInt8(ascii: "+")
                        || b == UInt8(ascii: ".") || b == UInt8(ascii: "e") || b == UInt8(ascii: "E") else { break }
                index += 1
            }
            let token = String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<index]), as: UTF8.self)
            if let n = Int64(token) { return .int(n) }
            guard let d = Double(token) else { throw DeviceStrictJSONError.malformed("bad number") }
            return .double(d)
        }

        private mutating func object() throws -> DeviceJSON {
            try enter()
            index += 1 // {
            var members: [String: DeviceJSON] = [:]
            var seen = Set<[UInt8]>()
            skipWhitespace()
            if try peek() == UInt8(ascii: "}") {
                index += 1
                depth -= 1
                return .object(members)
            }
            while true {
                skipWhitespace()
                guard try peek() == UInt8(ascii: "\"") else { throw DeviceStrictJSONError.malformed("expected key") }
                let keyBytes = try string()
                let key = String(decoding: keyBytes, as: UTF8.self)
                guard seen.insert(keyBytes).inserted else { throw DeviceStrictJSONError.duplicateKey(key) }
                guard members[key] == nil else {
                    // Byte-distinct but canonically equivalent: a Swift
                    // String-keyed object would merge them (never reinterpret).
                    throw DeviceStrictJSONError.malformed("canonically equivalent keys in one object")
                }
                skipWhitespace()
                guard try peek() == UInt8(ascii: ":") else { throw DeviceStrictJSONError.malformed("expected ':'") }
                index += 1
                skipWhitespace()
                members[key] = try value()
                skipWhitespace()
                let next = try peek()
                index += 1
                if next == UInt8(ascii: "}") { break }
                guard next == UInt8(ascii: ",") else { throw DeviceStrictJSONError.malformed("expected ',' or '}'") }
            }
            depth -= 1
            return .object(members)
        }

        private mutating func array() throws -> DeviceJSON {
            try enter()
            index += 1 // [
            var items: [DeviceJSON] = []
            skipWhitespace()
            if try peek() == UInt8(ascii: "]") {
                index += 1
                depth -= 1
                return .array(items)
            }
            while true {
                skipWhitespace()
                items.append(try value())
                skipWhitespace()
                let next = try peek()
                index += 1
                if next == UInt8(ascii: "]") { break }
                guard next == UInt8(ascii: ",") else { throw DeviceStrictJSONError.malformed("expected ',' or ']'") }
            }
            depth -= 1
            return .array(items)
        }

        private mutating func literal(_ word: StaticString) throws {
            let count = word.utf8CodeUnitCount
            guard index + count <= bytes.count else { throw DeviceStrictJSONError.malformed("bad literal") }
            let expected = UnsafeBufferPointer(start: word.utf8Start, count: count)
            for offset in 0..<count where bytes[index + offset] != expected[offset] {
                throw DeviceStrictJSONError.malformed("bad literal")
            }
            index += count
        }

        private static func isDigit(_ b: UInt8) -> Bool {
            b >= UInt8(ascii: "0") && b <= UInt8(ascii: "9")
        }

        /// `-?(0|[1-9][0-9]*)`, at most 16 digits, magnitude ≤ 2^53 − 1.
        private mutating func number() throws -> Int64 {
            let negative = bytes[index] == UInt8(ascii: "-")
            if negative { index += 1 }
            guard index < bytes.count, Self.isDigit(bytes[index]) else {
                throw DeviceStrictJSONError.malformed("expected a digit")
            }
            var magnitude: UInt64 = 0
            if bytes[index] == UInt8(ascii: "0") {
                index += 1
                if index < bytes.count, Self.isDigit(bytes[index]) {
                    throw DeviceStrictJSONError.invalidNumber("leading zero")
                }
            } else {
                var digits = 0
                while index < bytes.count, Self.isDigit(bytes[index]) {
                    digits += 1
                    guard digits <= DeviceStrictJSON.maxIntegerDigits else {
                        throw DeviceStrictJSONError.invalidNumber("more than \(DeviceStrictJSON.maxIntegerDigits) digits")
                    }
                    magnitude = magnitude * 10 + UInt64(bytes[index] - UInt8(ascii: "0"))
                    index += 1
                }
            }
            if index < bytes.count {
                switch bytes[index] {
                case UInt8(ascii: "."), UInt8(ascii: "e"), UInt8(ascii: "E"):
                    throw DeviceStrictJSONError.invalidNumber("numbers are integer tokens: no fraction or exponent")
                default:
                    break
                }
            }
            if negative, magnitude == 0 {
                throw DeviceStrictJSONError.invalidNumber("-0 is not an integer token")
            }
            guard magnitude <= DeviceStrictJSON.maxIntegerMagnitude else {
                throw DeviceStrictJSONError.invalidNumber("integer magnitude above 2^53 - 1")
            }
            return negative ? -Int64(magnitude) : Int64(magnitude)
        }

        /// A string's UTF-8 bytes with escapes resolved. Rejects raw control
        /// characters, malformed UTF-8 and unpaired surrogate escapes.
        private mutating func string() throws -> [UInt8] {
            index += 1 // opening quote
            var out: [UInt8] = []
            while true {
                guard index < bytes.count else { throw DeviceStrictJSONError.malformed("unterminated string") }
                let b = bytes[index]
                switch b {
                case UInt8(ascii: "\""):
                    index += 1
                    return out
                case UInt8(ascii: "\\"):
                    index += 1
                    try escape(into: &out)
                case 0x00..<0x20:
                    throw DeviceStrictJSONError.invalidString("raw control character 0x\(String(b, radix: 16))")
                case 0x20..<0x80:
                    out.append(b)
                    index += 1
                default:
                    try utf8Sequence(into: &out)
                }
            }
        }

        private mutating func escape(into out: inout [UInt8]) throws {
            guard index < bytes.count else { throw DeviceStrictJSONError.invalidString("bad escape") }
            let e = bytes[index]
            index += 1
            switch e {
            case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"): out.append(e)
            case UInt8(ascii: "b"): out.append(0x08)
            case UInt8(ascii: "f"): out.append(0x0C)
            case UInt8(ascii: "n"): out.append(0x0A)
            case UInt8(ascii: "r"): out.append(0x0D)
            case UInt8(ascii: "t"): out.append(0x09)
            case UInt8(ascii: "u"):
                var scalar = try hex4()
                switch scalar {
                case 0xD800...0xDBFF:
                    guard index + 1 < bytes.count,
                          bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") else {
                        throw DeviceStrictJSONError.invalidString("unpaired high surrogate escape")
                    }
                    index += 2
                    let low = try hex4()
                    guard (0xDC00...0xDFFF).contains(low) else {
                        throw DeviceStrictJSONError.invalidString("unpaired high surrogate escape")
                    }
                    scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
                case 0xDC00...0xDFFF:
                    throw DeviceStrictJSONError.invalidString("unpaired low surrogate escape")
                default:
                    break
                }
                guard let resolved = Unicode.Scalar(scalar), let encoded = UTF8.encode(resolved) else {
                    throw DeviceStrictJSONError.invalidString("invalid \\u escape")
                }
                out.append(contentsOf: encoded)
            default:
                throw DeviceStrictJSONError.invalidString("bad escape")
            }
        }

        /// One well-formed multi-byte UTF-8 sequence (Unicode table 3-7):
        /// no overlongs, no encoded surrogates, nothing above U+10FFFF.
        private mutating func utf8Sequence(into out: inout [UInt8]) throws {
            let lead = bytes[index]
            let length: Int
            var secondRange: ClosedRange<UInt8> = 0x80...0xBF
            switch lead {
            case 0xC2...0xDF: length = 2
            case 0xE0: length = 3; secondRange = 0xA0...0xBF
            case 0xE1...0xEC, 0xEE...0xEF: length = 3
            case 0xED: length = 3; secondRange = 0x80...0x9F
            case 0xF0: length = 4; secondRange = 0x90...0xBF
            case 0xF1...0xF3: length = 4
            case 0xF4: length = 4; secondRange = 0x80...0x8F
            default: throw DeviceStrictJSONError.invalidString("invalid UTF-8 lead byte 0x\(String(lead, radix: 16))")
            }
            guard index + length <= bytes.count else { throw DeviceStrictJSONError.invalidString("truncated UTF-8 sequence") }
            guard secondRange.contains(bytes[index + 1]) else {
                throw DeviceStrictJSONError.invalidString("invalid UTF-8 sequence")
            }
            var offset = 2
            while offset < length {
                guard (0x80...0xBF).contains(bytes[index + offset]) else {
                    throw DeviceStrictJSONError.invalidString("invalid UTF-8 sequence")
                }
                offset += 1
            }
            out.append(contentsOf: bytes[index..<(index + length)])
            index += length
        }

        private mutating func hex4() throws -> UInt32 {
            guard index + 4 <= bytes.count else { throw DeviceStrictJSONError.invalidString("bad \\u escape") }
            var value: UInt32 = 0
            for _ in 0..<4 {
                let b = bytes[index]
                index += 1
                let digit: UInt32
                switch b {
                case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(b - UInt8(ascii: "0"))
                case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(b - UInt8(ascii: "a") + 10)
                case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(b - UInt8(ascii: "A") + 10)
                default: throw DeviceStrictJSONError.invalidString("bad \\u escape")
                }
                value = value << 4 | digit
            }
            return value
        }
    }
}

// MARK: - Tree decoder

/// The only decoder on the device input path: reads a `DeviceJSON` tree that
/// `DeviceStrictJSON.parse` produced (or a payload object held by a decoded
/// message). Integers convert exactly (`T(exactly:)`); there is no
/// floating-point path, so `1.0`-style spellings can never reach a typed
/// field.
struct DeviceJSONTreeDecoder: Decoder {
    let value: DeviceJSON
    let codingPath: [any CodingKey]
    var userInfo: [CodingUserInfoKey: Any] { [:] }

    init(value: DeviceJSON, codingPath: [any CodingKey] = []) {
        self.value = value
        self.codingPath = codingPath
    }

    func container<Key: CodingKey>(keyedBy type: Key.Type) throws -> KeyedDecodingContainer<Key> {
        guard case let .object(object) = value else {
            throw Self.mismatch([String: Any].self, codingPath, "expected a JSON object")
        }
        return KeyedDecodingContainer(Keyed<Key>(object: object, codingPath: codingPath))
    }

    func unkeyedContainer() throws -> any UnkeyedDecodingContainer {
        guard case let .array(items) = value else {
            throw Self.mismatch([Any].self, codingPath, "expected a JSON array")
        }
        return Unkeyed(items: items, codingPath: codingPath)
    }

    func singleValueContainer() throws -> any SingleValueDecodingContainer {
        Single(value: value, codingPath: codingPath)
    }

    static func mismatch(_ type: Any.Type, _ path: [any CodingKey], _ detail: String) -> DecodingError {
        DecodingError.typeMismatch(type, DecodingError.Context(codingPath: path, debugDescription: detail))
    }

    static func bool(_ value: DeviceJSON, _ path: [any CodingKey]) throws -> Bool {
        guard case let .bool(b) = value else { throw mismatch(Bool.self, path, "expected a boolean") }
        return b
    }

    static func string(_ value: DeviceJSON, _ path: [any CodingKey]) throws -> String {
        guard case let .string(s) = value else { throw mismatch(String.self, path, "expected a string") }
        return s
    }

    static func integer<T: FixedWidthInteger>(_ type: T.Type, _ value: DeviceJSON, _ path: [any CodingKey]) throws -> T {
        guard case let .int(n) = value else { throw mismatch(type, path, "expected an integer") }
        guard let exact = T(exactly: n) else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: path, debugDescription: "\(n) does not fit \(T.self)"))
        }
        return exact
    }

    static func floating(_ type: Any.Type, _ path: [any CodingKey]) -> DecodingError {
        mismatch(type, path, "device messages carry integers only")
    }

    static func nested<T: Decodable>(_ type: T.Type, _ value: DeviceJSON, _ path: [any CodingKey]) throws -> T {
        if T.self == DeviceJSON.self { return value as! T }
        if T.self == DeviceJSONObject.self {
            guard case let .object(object) = value else { throw mismatch(type, path, "expected a JSON object") }
            return object as! T
        }
        return try T(from: DeviceJSONTreeDecoder(value: value, codingPath: path))
    }

    struct Keyed<Key: CodingKey>: KeyedDecodingContainerProtocol {
        let object: [String: DeviceJSON]
        let codingPath: [any CodingKey]

        var allKeys: [Key] { object.keys.compactMap { Key(stringValue: $0) } }

        func contains(_ key: Key) -> Bool { object[key.stringValue] != nil }

        private func child(_ key: Key) throws -> DeviceJSON {
            guard let value = object[key.stringValue] else {
                throw DecodingError.keyNotFound(key, DecodingError.Context(
                    codingPath: codingPath, debugDescription: "missing key '\(key.stringValue)'"))
            }
            return value
        }

        private func path(_ key: Key) -> [any CodingKey] { codingPath + [key] }

        func decodeNil(forKey key: Key) throws -> Bool { try child(key) == .null }
        func decode(_ type: Bool.Type, forKey key: Key) throws -> Bool { try DeviceJSONTreeDecoder.bool(child(key), path(key)) }
        func decode(_ type: String.Type, forKey key: Key) throws -> String { try DeviceJSONTreeDecoder.string(child(key), path(key)) }
        func decode(_ type: Double.Type, forKey key: Key) throws -> Double { throw DeviceJSONTreeDecoder.floating(type, path(key)) }
        func decode(_ type: Float.Type, forKey key: Key) throws -> Float { throw DeviceJSONTreeDecoder.floating(type, path(key)) }
        func decode(_ type: Int.Type, forKey key: Key) throws -> Int { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: Int8.Type, forKey key: Key) throws -> Int8 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: Int16.Type, forKey key: Key) throws -> Int16 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: Int32.Type, forKey key: Key) throws -> Int32 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: Int64.Type, forKey key: Key) throws -> Int64 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: UInt.Type, forKey key: Key) throws -> UInt { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: UInt8.Type, forKey key: Key) throws -> UInt8 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: UInt16.Type, forKey key: Key) throws -> UInt16 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: UInt32.Type, forKey key: Key) throws -> UInt32 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }
        func decode(_ type: UInt64.Type, forKey key: Key) throws -> UInt64 { try DeviceJSONTreeDecoder.integer(type, child(key), path(key)) }

        func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T {
            try DeviceJSONTreeDecoder.nested(type, child(key), path(key))
        }

        func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type, forKey key: Key) throws -> KeyedDecodingContainer<NestedKey> {
            try DeviceJSONTreeDecoder(value: child(key), codingPath: path(key)).container(keyedBy: type)
        }

        func nestedUnkeyedContainer(forKey key: Key) throws -> any UnkeyedDecodingContainer {
            try DeviceJSONTreeDecoder(value: child(key), codingPath: path(key)).unkeyedContainer()
        }

        func superDecoder() throws -> any Decoder {
            DeviceJSONTreeDecoder(value: .object(object), codingPath: codingPath)
        }

        func superDecoder(forKey key: Key) throws -> any Decoder {
            DeviceJSONTreeDecoder(value: try child(key), codingPath: path(key))
        }
    }

    struct IndexKey: CodingKey {
        let intValue: Int?
        var stringValue: String { "\(intValue ?? 0)" }
        init(_ index: Int) { intValue = index }
        init?(stringValue: String) { return nil }
        init?(intValue: Int) { self.intValue = intValue }
    }

    struct Unkeyed: UnkeyedDecodingContainer {
        let items: [DeviceJSON]
        let codingPath: [any CodingKey]
        var currentIndex = 0

        init(items: [DeviceJSON], codingPath: [any CodingKey]) {
            self.items = items
            self.codingPath = codingPath
        }

        var count: Int? { items.count }
        var isAtEnd: Bool { currentIndex >= items.count }
        private var path: [any CodingKey] { codingPath + [IndexKey(currentIndex)] }

        private mutating func next() throws -> DeviceJSON {
            guard !isAtEnd else {
                throw DecodingError.valueNotFound(DeviceJSON.self, DecodingError.Context(
                    codingPath: codingPath, debugDescription: "array exhausted"))
            }
            defer { currentIndex += 1 }
            return items[currentIndex]
        }

        mutating func decodeNil() throws -> Bool {
            guard !isAtEnd else { return false }
            if items[currentIndex] == .null {
                currentIndex += 1
                return true
            }
            return false
        }

        mutating func decode(_ type: Bool.Type) throws -> Bool { let p = path; return try DeviceJSONTreeDecoder.bool(next(), p) }
        mutating func decode(_ type: String.Type) throws -> String { let p = path; return try DeviceJSONTreeDecoder.string(next(), p) }
        mutating func decode(_ type: Double.Type) throws -> Double { throw DeviceJSONTreeDecoder.floating(type, path) }
        mutating func decode(_ type: Float.Type) throws -> Float { throw DeviceJSONTreeDecoder.floating(type, path) }
        mutating func decode(_ type: Int.Type) throws -> Int { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: Int8.Type) throws -> Int8 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: Int16.Type) throws -> Int16 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: Int32.Type) throws -> Int32 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: Int64.Type) throws -> Int64 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: UInt.Type) throws -> UInt { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: UInt8.Type) throws -> UInt8 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: UInt16.Type) throws -> UInt16 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: UInt32.Type) throws -> UInt32 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }
        mutating func decode(_ type: UInt64.Type) throws -> UInt64 { let p = path; return try DeviceJSONTreeDecoder.integer(type, next(), p) }

        mutating func decode<T: Decodable>(_ type: T.Type) throws -> T {
            let p = path
            return try DeviceJSONTreeDecoder.nested(type, next(), p)
        }

        mutating func nestedContainer<NestedKey: CodingKey>(keyedBy type: NestedKey.Type) throws -> KeyedDecodingContainer<NestedKey> {
            let p = path
            return try DeviceJSONTreeDecoder(value: next(), codingPath: p).container(keyedBy: type)
        }

        mutating func nestedUnkeyedContainer() throws -> any UnkeyedDecodingContainer {
            let p = path
            return try DeviceJSONTreeDecoder(value: next(), codingPath: p).unkeyedContainer()
        }

        mutating func superDecoder() throws -> any Decoder {
            let p = path
            return DeviceJSONTreeDecoder(value: try next(), codingPath: p)
        }
    }

    struct Single: SingleValueDecodingContainer {
        let value: DeviceJSON
        let codingPath: [any CodingKey]

        func decodeNil() -> Bool { value == .null }
        func decode(_ type: Bool.Type) throws -> Bool { try DeviceJSONTreeDecoder.bool(value, codingPath) }
        func decode(_ type: String.Type) throws -> String { try DeviceJSONTreeDecoder.string(value, codingPath) }
        func decode(_ type: Double.Type) throws -> Double { throw DeviceJSONTreeDecoder.floating(type, codingPath) }
        func decode(_ type: Float.Type) throws -> Float { throw DeviceJSONTreeDecoder.floating(type, codingPath) }
        func decode(_ type: Int.Type) throws -> Int { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: Int8.Type) throws -> Int8 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: Int16.Type) throws -> Int16 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: Int32.Type) throws -> Int32 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: Int64.Type) throws -> Int64 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: UInt.Type) throws -> UInt { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: UInt8.Type) throws -> UInt8 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: UInt16.Type) throws -> UInt16 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: UInt32.Type) throws -> UInt32 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }
        func decode(_ type: UInt64.Type) throws -> UInt64 { try DeviceJSONTreeDecoder.integer(type, value, codingPath) }

        func decode<T: Decodable>(_ type: T.Type) throws -> T {
            try DeviceJSONTreeDecoder.nested(type, value, codingPath)
        }
    }
}

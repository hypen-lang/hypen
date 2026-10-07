import Foundation

// Device Capability Protocol — closed-schema validation of capability
// payloads (RFC 001 §3) for every revision in `DeviceRegistry`, mirroring the
// exported revision schemas in
// `engine-compatibility-tests/schema/device/<capability>-v1.schema.json`
// (`$defs/params|result|event`) plus the rules no schema keyword expresses
// (unique blob channels in a result, unique names in a `core.capabilities`
// snapshot). Pinned by `fixtures/device/conformance/payloads.json`.
//
// The host validates every inbound `params` with it (so a capability without
// an iOS driver is still refused precisely), and every outbound
// `result`/`event` before sending, so a driver bug surfaces as `internal`
// instead of an invalid message on the wire.

/// Which part of a capability revision a payload is.
public enum DevicePayloadKind: String, Sendable, CaseIterable {
    case params
    case result
    case event
}

/// Optional progress state (§2.1): consumes no data credit and never goes
/// back to `pendingConsent` after `running` or after data.
public enum DeviceProgressState: String, Sendable, CaseIterable {
    case pendingConsent
    case running
}

public enum DevicePayloads {
    static let contentTypeMax = 256
    static let fileNameMax = 512
    static let capabilityNameMax = 128

    /// `permission.*@1`'s closed `Permission` enum (P1), exact bytes.
    public static let permissionNames: [String] = DevicePermission.allCases.map { $0.rawValue }
    /// `camera.capture@1` item media types (bare, no codec parameters).
    public static let cameraPhotoTypes: Set<String> = ["image/jpeg", "image/heic"]
    public static let cameraVideoTypes: Set<String> = ["video/mp4", "video/quicktime", "video/webm"]
    /// `bluetooth.select@1` service UUIDs: canonical lowercase 128-bit form.
    public static func isCanonicalUUID(_ s: String) -> Bool {
        let bytes = Array(s.utf8)
        guard bytes.count == 36 else { return false }
        for (i, b) in bytes.enumerated() {
            if i == 8 || i == 13 || i == 18 || i == 23 {
                if b != 0x2D { return false }
            } else if !((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)) {
                return false
            }
        }
        return true
    }

    /// Request-dependent blob rule (§2.4 disallowed metadata): a
    /// `camera.capture` item's media type must fit the requested `mode`.
    /// nil when `contentType` is allowed for `params`.
    public static func blobStartViolation(_ capability: String, params: DeviceJSONObject,
                                          contentType: String) -> String? {
        guard capability == "camera.capture" else { return nil }
        switch params["mode"] {
        case .string("photo")?:
            return cameraPhotoTypes.contains(contentType) ? nil : "a photo item must be image/jpeg or image/heic"
        case .string("video")?:
            return cameraVideoTypes.contains(contentType) ? nil : "a video item must be video/mp4, video/quicktime or video/webm"
        default:
            return "camera.capture params carry no mode"
        }
    }

    struct Invalid: Error, CustomStringConvertible {
        let description: String
    }

    static func bad(_ what: String) -> Invalid { Invalid(description: what) }

    /// nil when `value` is a valid `kind` payload of `capability@version`,
    /// else the first violation. A revision the registry does not declare is
    /// never valid.
    public static func validate(_ capability: String, version: UInt32,
                                kind: DevicePayloadKind, value: DeviceJSON) -> String? {
        guard let rev = DeviceRegistry.find(capability, version: version) else {
            return "\(capability)@\(version) is not a registry revision"
        }
        do {
            switch kind {
            case .params: try params(capability, rev, value)
            case .result: try result(capability, rev, value)
            case .event: try event(capability, rev, value)
            }
            return nil
        } catch let error as Invalid {
            return "\(kind.rawValue): \(error.description)"
        } catch {
            return "\(kind.rawValue): \(error)"
        }
    }

    /// Run a shape check, returning its violation (or nil).
    static func check(_ block: () throws -> Void) -> String? {
        do {
            try block()
            return nil
        } catch let error as Invalid {
            return error.description
        } catch {
            return "\(error)"
        }
    }

    // MARK: Per-capability shapes

    private static func params(_ capability: String, _ rev: DeviceRevisionPolicy, _ value: DeviceJSON) throws {
        switch capability {
        case "gallery.pick":
            let o = try obj(value, "params", ["mediaTypes", "maxCount"])
            _ = try array(o["mediaTypes"], "mediaTypes", min: 1, max: 2, unique: true) {
                try enumString($0, "mediaTypes[]", ["photo", "video"])
            }
            _ = try int(o["maxCount"], "maxCount", 1, Int64(rev.maxItems))
        case "file.pick":
            let o = try obj(value, "params", ["accept", "maxCount"])
            _ = try array(o["accept"], "accept", min: 0, max: 32) { try string($0, "accept[]", 0, 128) }
            _ = try int(o["maxCount"], "maxCount", 1, Int64(rev.maxItems))
        case "file.save":
            let o = try obj(value, "params", ["channel", "name", "contentType", "bytes", "sha256"])
            _ = try int(o["channel"], "channel", 0, 0)
            _ = try string(o["name"], "name", 0, fileNameMax)
            _ = try string(o["contentType"], "contentType", 0, contentTypeMax)
            _ = try int(o["bytes"], "bytes", 1, Int64(rev.maxItemBytes))
            try sha256(o["sha256"], "sha256")
        case "mic.record":
            let o = try obj(value, "params", ["sampleRate", "format"], optional: ["maxDurationMs", "channels"])
            _ = try int(o["sampleRate"], "sampleRate", 8_000, 192_000)
            _ = try enumString(o["format"], "format", ["pcm16"])
            if o["maxDurationMs"] != nil { _ = try int(o["maxDurationMs"], "maxDurationMs", 1, 600_000) }
            if o["channels"] != nil { _ = try int(o["channels"], "channels", 1, 2) }
        case "permission.query", "permission.request":
            let o = try obj(value, "params", ["permission"])
            _ = try enumString(o["permission"], "permission", Set(permissionNames))
        case "camera.capture":
            guard case let .object(raw) = value else { throw bad("params must be an object") }
            // oneOf keyed by mode: maxDurationMs is video-only.
            let isVideo = raw["mode"] == .string("video")
            let o = try obj(value, "params", ["mode"], optional: isVideo ? ["facing", "maxDurationMs"] : ["facing"])
            _ = try enumString(o["mode"], "mode", ["photo", "video"])
            if o["facing"] != nil { _ = try enumString(o["facing"], "facing", ["front", "back"]) }
            if o["maxDurationMs"] != nil { _ = try int(o["maxDurationMs"], "maxDurationMs", 1, 600_000) }
        case "bluetooth.select":
            let o = try obj(value, "params", [], optional: ["services", "namePrefix"])
            if o["services"] != nil {
                _ = try array(o["services"], "services", min: 1, max: 16, unique: true) { item -> String in
                    let s = try string(item, "services[]", 36, 36)
                    guard isCanonicalUUID(s) else { throw bad("services[] must be a lowercase 128-bit UUID") }
                    return s
                }
            }
            if o["namePrefix"] != nil { _ = try string(o["namePrefix"], "namePrefix", 1, 64) }
        case "bluetooth.scan", "core.capabilities":
            _ = try obj(value, "params", [])
        default:
            throw bad("no params schema for \(capability)")
        }
    }

    private static func result(_ capability: String, _ rev: DeviceRevisionPolicy, _ value: DeviceJSON) throws {
        switch capability {
        case "gallery.pick":
            let o = try obj(value, "result", ["items"])
            let items = try array(o["items"], "items", min: 0, max: rev.maxItems) { try blobItem($0, rev) }
            try uniqueChannels(items)
        case "file.pick":
            let o = try obj(value, "result", ["items"])
            let items = try array(o["items"], "items", min: 0, max: rev.maxItems) { item -> DeviceJSONObject in
                let i = try obj(item, "item", ["channel", "name", "contentType", "bytes", "sha256"])
                _ = try string(i["name"], "item.name", 0, fileNameMax)
                try blobItemFields(i, rev)
                return i
            }
            try uniqueChannels(items)
        case "file.save":
            let o = try obj(value, "result", ["bytesWritten"])
            _ = try int(o["bytesWritten"], "bytesWritten", 0, Int64(rev.maxItemBytes))
        case "camera.capture":
            let o = try obj(value, "result", ["items"])
            let items = try array(o["items"], "items", min: 1, max: 1) { try blobItem($0, rev) }
            try uniqueChannels(items)
        case "bluetooth.select":
            let o = try obj(value, "result", ["device"])
            let d = try obj(o["device"], "device", ["id"], optional: ["name"])
            _ = try string(d["id"], "device.id", 1, 128)
            if d["name"] != nil { _ = try string(d["name"], "device.name", 0, 256) }
        case "mic.record":
            let o = try obj(value, "result", ["durationMs", "item"])
            _ = try int(o["durationMs"], "durationMs", 0, Int64(DeviceWire.maxSafeInteger))
            _ = try blobItem(o["item"], rev)
        case "permission.query", "permission.request":
            let o = try obj(value, "result", ["status"])
            _ = try enumString(o["status"], "status", ["granted", "denied", "prompt"])
        case "bluetooth.scan", "core.capabilities":
            _ = try obj(value, "result", [])
        default:
            throw bad("no result schema for \(capability)")
        }
    }

    private static func event(_ capability: String, _ rev: DeviceRevisionPolicy, _ value: DeviceJSON) throws {
        guard case let .object(o) = value else { throw bad("event must be an object") }
        switch o["kind"] {
        case .string("progress")?:
            _ = try obj(value, "progress", ["kind", "state"])
            _ = try enumString(o["state"], "state", Set(DeviceProgressState.allCases.map { $0.rawValue }))
            return
        case .string("blobStart")? where rev.data == .binaryUpload:
            _ = try obj(value, "blobStart", ["kind", "channel", "contentType"], optional: ["bytes"])
            _ = try int(o["channel"], "channel", 0, Int64(rev.maxItems) - 1)
            try contentType(o["contentType"], "contentType", capability)
            if o["bytes"] != nil { _ = try int(o["bytes"], "bytes", 0, Int64(rev.maxItemBytes)) }
            return
        default:
            break
        }
        switch capability {
        case "core.capabilities":
            try capabilities(value)
        case "bluetooth.scan":
            _ = try obj(value, "event", ["device"])
            let d = try obj(o["device"], "device", ["id", "rssi"], optional: ["name"])
            _ = try string(d["id"], "device.id", 0, 128)
            if d["name"] != nil { _ = try string(d["name"], "device.name", 0, 256) }
            _ = try int(d["rssi"], "device.rssi", -32_768, 32_767)
        default:
            throw bad("event is not defined for \(capability)@\(rev.version)")
        }
    }

    /// A `core.capabilities` snapshot body `{capabilities:[{name, versions}]}`
    /// (handshake-v1 `capabilitiesEvent`, unique names by exact bytes).
    static func capabilities(_ value: DeviceJSON) throws {
        let o = try obj(value, "capabilities event", ["capabilities"])
        let offers = try array(o["capabilities"], "capabilities", min: 0, max: 64) { try offer($0) }
        if DeviceWire.hasDuplicateNames(offers.compactMap { $0["name"]?.stringValue }) {
            throw bad("capability named twice")
        }
    }

    /// `capabilitiesEvent` validation; nil when valid.
    public static func validateCapabilitiesEvent(_ value: DeviceJSON) -> String? {
        check { try capabilities(value) }
    }

    static func offer(_ value: DeviceJSON) throws -> DeviceJSONObject {
        let o = try obj(value, "capability offer", ["name", "versions"])
        _ = try string(o["name"], "name", 1, capabilityNameMax)
        _ = try array(o["versions"], "versions", min: 0, max: 32, unique: true) {
            try int($0, "versions[]", 1, Int64(UInt32.max))
        }
        return o
    }

    private static func blobItem(_ value: DeviceJSON?, _ rev: DeviceRevisionPolicy) throws -> DeviceJSONObject {
        let i = try obj(value, "item", ["channel", "contentType", "bytes", "sha256"])
        try blobItemFields(i, rev)
        return i
    }

    private static func blobItemFields(_ i: DeviceJSONObject, _ rev: DeviceRevisionPolicy) throws {
        _ = try int(i["channel"], "item.channel", 0, Int64(rev.maxItems) - 1)
        try contentType(i["contentType"], "item.contentType", rev.capability)
        _ = try int(i["bytes"], "item.bytes", 0, Int64(rev.maxItemBytes))
        try sha256(i["sha256"], "item.sha256")
    }

    /// A blob media type: the camera's closed set, else any bounded string.
    private static func contentType(_ value: DeviceJSON?, _ what: String, _ capability: String) throws {
        if capability == "camera.capture" {
            _ = try enumString(value, what, cameraPhotoTypes.union(cameraVideoTypes))
        } else {
            _ = try string(value, what, 0, contentTypeMax)
        }
    }

    private static func uniqueChannels(_ items: [DeviceJSONObject]) throws {
        let channels = items.compactMap { $0["channel"]?.int64Value }
        if Set(channels).count != channels.count { throw bad("item channel repeated") }
    }

    // MARK: Primitives

    static func obj(_ value: DeviceJSON?, _ what: String, _ required: Set<String>,
                    optional: Set<String> = []) throws -> DeviceJSONObject {
        guard case let .object(o)? = value else { throw bad("\(what) must be an object") }
        for key in o.keys where !required.contains(key) && !optional.contains(key) {
            throw bad("\(what): unknown key '\(key)'")
        }
        for key in required where o[key] == nil {
            throw bad("\(what): missing '\(key)'")
        }
        return o
    }

    static func array<T>(_ value: DeviceJSON?, _ what: String, min: Int, max: Int, unique: Bool = false,
                         _ item: (DeviceJSON) throws -> T) throws -> [T] {
        guard case let .array(list)? = value else { throw bad("\(what) must be an array") }
        if list.count < min { throw bad("\(what) needs at least \(min) items") }
        if list.count > max { throw bad("\(what) has more than \(max) items") }
        if unique, Set(list).count != list.count { throw bad("\(what) items must be unique") }
        return try list.map(item)
    }

    static func string(_ value: DeviceJSON?, _ what: String, _ min: Int, _ max: Int) throws -> String {
        guard case let .string(s)? = value else { throw bad("\(what) must be a string") }
        let length = DeviceWire.codePointCount(s)
        if length < min || length > max { throw bad("\(what) must be \(min)..\(max) code points") }
        return s
    }

    static func enumString(_ value: DeviceJSON?, _ what: String, _ allowed: Set<String>) throws -> String {
        guard case let .string(s)? = value else { throw bad("\(what) must be a string") }
        // Exact bytes: an enum never matches a canonically-equivalent spelling.
        guard allowed.contains(where: { DeviceWire.sameName($0, s) }) else {
            throw bad("\(what) must be one of \(allowed.sorted())")
        }
        return s
    }

    static func int(_ value: DeviceJSON?, _ what: String, _ min: Int64, _ max: Int64) throws -> Int64 {
        guard case let .int(v)? = value else { throw bad("\(what) must be an integer") }
        if v < min || v > max { throw bad("\(what) must be within \(min)..\(max)") }
        return v
    }

    static func sha256(_ value: DeviceJSON?, _ what: String) throws {
        guard case let .string(s)? = value else { throw bad("\(what) must be a string") }
        guard s.utf8.count == 64,
              s.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }) else {
            throw bad("\(what) must be 64 lowercase hex digits")
        }
    }
}

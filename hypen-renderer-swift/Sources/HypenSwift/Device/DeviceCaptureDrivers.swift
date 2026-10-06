import Foundation

// Device Capability Protocol — round-3 capability drivers (RFC 001 §2.4, §3,
// §5): `file.pick`, `file.save` (native download plane), `camera.capture`,
// `mic.record` and `bluetooth.select`.
//
// Like `DeviceDrivers.swift`, the protocol logic lives here and talks to the
// OS only through small backend protocols, so it is unit-tested on Linux
// through fakes. `DeviceHostIOSCapture.swift` supplies the UIKit /
// AVFoundation / CoreBluetooth implementations.
//
// Params are validated against the revision schema by the host before a
// driver starts (`DevicePayloads`), so drivers read them without re-checking
// their shape.

// MARK: - Shared helpers

/// Host-side helpers shared by the capture drivers (pure, testable).
public enum DeviceCaptureSupport {
    /// A server-supplied file name made safe to hand to a platform save API
    /// and to show: path separators, controls and format characters become
    /// `_`, the result is trimmed and bounded to 255 scalars; an empty, `.`
    /// or `..` name becomes `download`. Mirrors the web host's `safeFileName`.
    public static func safeFileName(_ name: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in name.unicodeScalars {
            let v = scalar.value
            let unsafe = scalar == "/" || scalar == "\\" || v < 0x20 || (v >= 0x7F && v <= 0x9F)
                || v == 0x2028 || v == 0x2029 || scalar.properties.generalCategory == .format
            scalars.append(unsafe ? "_" : scalar)
        }
        let trimmed = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
        var bounded = String.UnicodeScalarView()
        bounded.append(contentsOf: trimmed.unicodeScalars.prefix(255))
        let result = String(bounded)
        return result.isEmpty || result == "." || result == ".." ? "download" : result
    }

    /// The extension of a sanitized name (`""` when none), lowercased and
    /// restricted to `[a-z0-9]` (at most 16), for host-owned labels.
    public static func fileExtension(_ name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
        let ext = name[name.index(after: dot)...].lowercased()
        guard !ext.isEmpty, ext.count <= 16,
              ext.unicodeScalars.allSatisfy({ ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") }) else { return "" }
        return ext
    }

    /// `1.5 MB`-style size for host-owned labels.
    public static func formatBytes(_ bytes: UInt64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let units = ["KB", "MB", "GB"]
        var value = Double(bytes) / 1024
        var unit = 0
        while value >= 1024, unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        return String(format: value < 10 ? "%.1f" : "%.0f", value) + " " + units[unit]
    }

    /// Whether `name` starts with `prefix` by exact code points (never
    /// canonical equivalence, like every protocol name comparison).
    public static func hasPrefix(_ name: String, _ prefix: String) -> Bool {
        let n = Array(name.unicodeScalars)
        let p = Array(prefix.unicodeScalars)
        return n.count >= p.count && Array(n[0..<p.count]) == p
    }

    /// Bound a string to `max` code points.
    static func bounded(_ s: String, _ max: Int) -> String {
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: s.unicodeScalars.prefix(max))
        return String(scalars)
    }
}

/// One `file.pick` `accept` entry: a MIME type, a `type/*` wildcard, or a
/// file extension (`.pdf` or `pdf`). The platform picker maps them to its own
/// content types (UTType on iOS).
public enum DocumentTypeFilter: Sendable, Hashable {
    case mimeType(String)
    /// `image/*` → `image`.
    case mediaWildcard(String)
    /// `.pdf` / `pdf` → `pdf`.
    case fileExtension(String)

    /// Parse `accept`. Entries are trimmed and lowercased; blanks and
    /// `*/*` impose no filter. Returns nil when an entry is none of the
    /// three forms (the driver then refuses with `invalidParams`, rather
    /// than widening the server's filter to every file). An empty result
    /// means "any file".
    public static func parse(_ accept: [String]) -> [DocumentTypeFilter]? {
        var out: [DocumentTypeFilter] = []
        // RFC 6838 restricted names: an alphanumeric first character.
        func token(_ s: Substring) -> Bool {
            guard let first = s.unicodeScalars.first,
                  (first >= "a" && first <= "z") || (first >= "0" && first <= "9") else { return false }
            return s.unicodeScalars.allSatisfy {
                ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || "!#$&^_.+-".unicodeScalars.contains($0)
            }
        }
        for raw in accept {
            let entry = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if entry.isEmpty || entry == "*/*" || entry == "*" { continue }
            let filter: DocumentTypeFilter
            if let slash = entry.firstIndex(of: "/") {
                let type = entry[..<slash]
                let sub = entry[entry.index(after: slash)...]
                guard token(type) else { return nil }
                if sub == "*" {
                    filter = .mediaWildcard(String(type))
                } else {
                    guard token(sub) else { return nil }
                    filter = .mimeType(entry)
                }
            } else {
                let ext = entry.hasPrefix(".") ? entry.dropFirst() : Substring(entry)
                guard ext.split(separator: ".", omittingEmptySubsequences: false).allSatisfy(token) else { return nil }
                filter = .fileExtension(String(ext))
            }
            if !out.contains(filter) { out.append(filter) }
        }
        return out
    }
}

// MARK: - file.pick backend

/// One picked document with its bytes in hand (file-backed / memory-mapped
/// `Data` on iOS, so a large file is never resident).
public struct PickedDocument: Sendable {
    public let name: String
    public let contentType: String
    public let data: Data
    /// Releases the backing resource (security-scoped access, a private
    /// clone) once the operation ends — after its upload, or on cancel.
    public let release: (@Sendable @MainActor () -> Void)?

    public init(name: String, contentType: String, data: Data,
                release: (@Sendable @MainActor () -> Void)? = nil) {
        self.name = name
        self.contentType = contentType
        self.data = data
        self.release = release
    }
}

public enum DocumentPickOutcome: Sendable {
    case picked([PickedDocument])
    /// Dismissed without choosing: `cancelled` (§2.6 step 4).
    case dismissed
    /// A chosen file exceeds `maxItemBytes` (checked before reading): `throttled`.
    case tooLarge
    /// The picker could not be shown after all: `unavailable`.
    case presentationFailed
    /// Reading failed; a fixed diagnostic token (never OS error text).
    case failed(String)
}

/// The system document picker (UIDocumentPickerViewController on iOS). It is
/// the per-use gate itself, like the gallery picker.
@MainActor
public protocol DocumentPicker: AnyObject, Sendable {
    /// Present an "open" picker. Returns nil when it cannot be presented.
    /// `selected` runs once the user chose and the picker UI is gone.
    func presentOpen(filters: [DocumentTypeFilter],
                     maxCount: Int,
                     maxItemBytes: UInt64,
                     selected: @escaping @Sendable @MainActor () -> Void,
                     completion: @escaping @Sendable @MainActor (DocumentPickOutcome) -> Void) -> DeviceCancellable?
}

// MARK: - file.pick

/// `file.pick@1`: the system document picker is the per-use gate. Every
/// picked file is an existing file of known size, so each item declares its
/// size; items carry `name`.
@MainActor
public final class FilePickDriver: DeviceDriver {
    public let capability = "file.pick"
    private let picker: DocumentPicker

    public init(picker: DocumentPicker) {
        self.picker = picker
    }

    public func start(_ op: DeviceOperation) {
        let accept = op.request.params["accept"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        let maxCount = Int(op.request.params["maxCount"]?.int64Value ?? 1)
        guard let filters = DocumentTypeFilter.parse(accept) else {
            op.fail(.invalidParams, "accept")
            return
        }
        if let blocked = op.acquirePrompt() {
            op.fail(blocked)
            return
        }
        op.progress(.pendingConsent)
        let handle = picker.presentOpen(filters: filters, maxCount: maxCount,
                                        maxItemBytes: op.policy.maxItemBytes,
                                        selected: {
            op.releasePrompt()
            op.markUserChoiceMade()
        }) { outcome in
            op.releasePrompt()
            switch outcome {
            case let .picked(documents) where !documents.isEmpty:
                let kept = Array(documents.prefix(maxCount))
                for document in documents.dropFirst(maxCount) { document.release?() }
                for document in kept {
                    if let release = document.release { op.onEnd { release() } }
                }
                guard !op.isSettled else { return }
                op.progress(.running)
                op.succeed([:], blobs: kept.map {
                    DeviceBlob(contentType: DeviceCaptureSupport.bounded($0.contentType, DevicePayloads.contentTypeMax),
                               bytes: $0.data, declaresSize: true,
                               itemFields: ["name": .string(DeviceCaptureSupport.bounded($0.name, DevicePayloads.fileNameMax))])
                })
            case let .picked(documents):
                documents.forEach { $0.release?() }
                op.fail(.cancelled, "picker-dismissed")
            case .dismissed:
                op.fail(.cancelled, "picker-dismissed")
            case .tooLarge:
                op.fail(.throttled, "item exceeds size limit")
            case .presentationFailed:
                op.fail(.unavailable, "presentation-failed")
            case let .failed(detail):
                op.fail(.internal, detail)
            }
        }
        guard let presented = handle else {
            op.releasePrompt()
            op.fail(.unavailable, "no-presenter")
            return
        }
        op.onCancel { presented.cancel() }
    }
}

// MARK: - file.save backend

/// Where a download is written. Bytes go to bounded storage (a temp file)
/// as they arrive — never the whole file in memory — and reach the chosen
/// destination only after the host verified the byte count and SHA-256.
@MainActor
public protocol DeviceFileSink: AnyObject {
    /// Append `data`; `completion(false)` on a write failure. Writes complete
    /// in order.
    func write(_ data: Data, completion: @escaping @Sendable @MainActor (Bool) -> Void)
    /// Every byte arrived and was verified: publish the file at the chosen
    /// destination.
    func commit(completion: @escaping @Sendable @MainActor (Bool) -> Void)
    /// Delete every partial output (temp file, destination placeholder).
    /// Idempotent; a no-op after a successful commit.
    func discard()
}

public enum FileSaveDestinationOutcome {
    /// The user chose a destination; the sink writes there.
    case chosen(DeviceFileSink)
    /// The destination picker was dismissed: `cancelled`.
    case dismissed
    case presentationFailed
    case failed(String)
}

/// The system destination picker (UIDocumentPickerViewController exporting
/// on iOS). The download is only granted credit after it resolves.
@MainActor
public protocol FileSaveDestinationPicker: AnyObject, Sendable {
    func chooseDestination(name: String,
                           contentType: String,
                           bytes: UInt64,
                           completion: @escaping @MainActor (FileSaveDestinationOutcome) -> Void) -> DeviceCancellable?
}

// MARK: - file.save

/// `file.save@1` over the server → client download plane (RFC 001 §2.3/§2.4,
/// C1). Order: host consent naming the origin, then the system destination
/// picker (reported as `pendingConsent`, the lease runs meanwhile); only
/// once a destination is chosen does the host grant credit — a window of at
/// most `window` bytes (≤ 256 KiB, ≤ the revision's outstanding bound) —
/// replenished only as bytes are durably written, so at most one window is
/// ever in memory. After the host verified byte count and SHA-256 and every
/// write finished, the sink commits and the driver answers `{bytesWritten}`.
/// Cancel, deadline, lease expiry, detach, a write failure or a verification
/// failure discard the partial output.
@MainActor
public final class FileSaveDriver: DeviceDriver {
    public static let maxWindow: UInt64 = 256 * 1024

    public let capability = "file.save"
    private let destination: FileSaveDestinationPicker
    private let presenter: DeviceConsentPresenter
    /// Credit window granted after the destination is chosen.
    public let window: UInt64

    public init(destination: FileSaveDestinationPicker,
                presenter: DeviceConsentPresenter,
                window: UInt64 = FileSaveDriver.maxWindow) {
        self.destination = destination
        self.presenter = presenter
        self.window = max(1, min(window, FileSaveDriver.maxWindow))
    }

    static func label(name: String, bytes: UInt64) -> String {
        let ext = DeviceCaptureSupport.fileExtension(name)
        let kind = ext.isEmpty ? "a file" : "a .\(ext) file"
        return "save \(kind) (\(DeviceCaptureSupport.formatBytes(bytes))) to your device"
    }

    public func start(_ op: DeviceOperation) {
        let params = op.request.params
        guard let bytes = params["bytes"]?.int64Value, bytes > 0 else {
            op.fail(.invalidParams, "bytes")
            return
        }
        let declared = UInt64(bytes)
        let name = DeviceCaptureSupport.safeFileName(params["name"]?.stringValue ?? "")
        let contentType = params["contentType"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "application/octet-stream"
        if let blocked = op.acquirePrompt() {
            op.fail(blocked)
            return
        }
        op.progress(.pendingConsent)
        let destination = self.destination
        let window = min(self.window, op.policy.maxOutstandingCredit, declared)
        let consent = presenter.presentConsent(origin: op.displayOrigin,
                                               operation: Self.label(name: name, bytes: declared)) { outcome in
            guard !op.isSettled else { return }
            switch outcome {
            case .accepted:
                break
            case .declined:
                op.releasePrompt()
                op.recordDenial()
                op.fail(.denied, "host-refused")
                return
            case .unavailable:
                op.releasePrompt()
                op.fail(.unavailable, "presentation-failed")
                return
            }
            op.recordAcceptance()
            let picked = destination.chooseDestination(name: name, contentType: contentType, bytes: declared) { outcome in
                guard !op.isSettled else {
                    if case let .chosen(sink) = outcome { sink.discard() }
                    return
                }
                op.releasePrompt()
                switch outcome {
                case let .chosen(sink):
                    Self.receive(op, into: sink, declared: declared, window: window)
                case .dismissed:
                    op.fail(.cancelled, "picker-dismissed")
                case .presentationFailed:
                    op.fail(.unavailable, "presentation-failed")
                case let .failed(detail):
                    op.fail(.internal, detail)
                }
            }
            guard let handle = picked else {
                op.releasePrompt()
                op.fail(.unavailable, "no-presenter")
                return
            }
            op.onCancel { handle.cancel() }
        }
        guard let handle = consent else {
            op.releasePrompt()
            op.fail(.unavailable, "no-presenter")
            return
        }
        op.onCancel { handle.cancel() }
    }

    /// Destination chosen: grant the first window, write chunks as they
    /// arrive, replenish credit per durable write, commit after verification.
    private static func receive(_ op: DeviceOperation, into sink: DeviceFileSink, declared: UInt64, window: UInt64) {
        let state = SaveState()
        // Partial output never survives an operation that did not commit.
        op.onEnd {
            if !state.committed { sink.discard() }
        }
        guard !op.isSettled else { return }
        // The user chose: a brief backgrounding does not discard it.
        op.markUserChoiceMade()
        op.progress(.running)
        let finishIfReady: @MainActor () -> Void = {
            guard state.verified, state.pendingWrites == 0, !state.committing, !op.isSettled else { return }
            state.committing = true
            sink.commit { ok in
                guard !op.isSettled else { return }
                guard ok else {
                    op.fail(.internal, "commit-failed")
                    return
                }
                state.committed = true
                op.succeed(["bytesWritten": .int(Int64(declared))])
            }
        }
        op.onDownloadChunk { chunk in
            state.pendingWrites += 1
            sink.write(chunk) { ok in
                state.pendingWrites -= 1
                guard !op.isSettled else { return }
                guard ok else {
                    op.fail(.internal, "write-failed")
                    return
                }
                state.written += UInt64(chunk.count)
                // Replenish what was durably written, never past the declaration.
                let room = declared - min(declared, state.granted)
                let amount = min(UInt64(chunk.count), room)
                if amount > 0 { state.granted += op.grantDownload(amount) }
                finishIfReady()
            }
        }
        op.onDownloadComplete {
            state.verified = true
            finishIfReady()
        }
        state.granted = op.grantDownload(window)
    }
}

@MainActor
private final class SaveState {
    var granted: UInt64 = 0
    var written: UInt64 = 0
    var pendingWrites = 0
    var verified = false
    var committing = false
    var committed = false
}

// MARK: - camera.capture backend

public struct CameraCaptureRequest: Sendable, Equatable {
    public enum Mode: String, Sendable { case photo, video }
    public enum Facing: String, Sendable { case front, back }

    public let mode: Mode
    public let facing: Facing?
    /// Video-only recording limit.
    public let maxDuration: TimeInterval?

    public init(mode: Mode, facing: Facing? = nil, maxDuration: TimeInterval? = nil) {
        self.mode = mode
        self.facing = facing
        self.maxDuration = maxDuration
    }
}

public enum CameraCaptureOutcome: Sendable {
    /// One captured item; `contentType` must fit the requested mode.
    case captured(PickedMedia)
    /// The capture UI was dismissed: `cancelled`.
    case dismissed
    /// The recording exceeds `maxItemBytes`: `throttled`.
    case tooLarge
    case presentationFailed
    case failed(String)
}

/// The system capture UI (UIImagePickerController with the camera source on
/// iOS): the per-use gate itself.
@MainActor
public protocol CameraCapturer: AnyObject, Sendable {
    /// Whether a camera (with `facing`, when given) exists at all.
    func isAvailable(facing: CameraCaptureRequest.Facing?) -> Bool
    /// Present the capture UI. Returns nil when it cannot be presented.
    /// `captured` runs once the user took the photo / finished recording and
    /// the UI is gone, before the item is encoded and loaded.
    func presentCapture(_ request: CameraCaptureRequest,
                        maxItemBytes: UInt64,
                        captured: @escaping @Sendable @MainActor () -> Void,
                        completion: @escaping @Sendable @MainActor (CameraCaptureOutcome) -> Void) -> DeviceCancellable?
}

// MARK: - camera.capture

/// `camera.capture@1` (C2): the system capture UI is the per-use gate
/// (reported as `pendingConsent` while open). Needs the `camera` permission,
/// plus `microphone` for video; a permission still undetermined is requested
/// through the platform flow first, and a refusal is `denied` with the
/// permission name as detail. Exactly one item on channel 0 whose media type
/// fits the mode (the host enforces it too).
@MainActor
public final class CameraCaptureDriver: DeviceDriver {
    public let capability = "camera.capture"
    private let capturer: CameraCapturer
    private let authority: DevicePermissionAuthority

    public init(capturer: CameraCapturer, authority: DevicePermissionAuthority) {
        self.capturer = capturer
        self.authority = authority
    }

    static func request(from params: DeviceJSONObject) -> CameraCaptureRequest? {
        guard let mode = params["mode"]?.stringValue.flatMap(CameraCaptureRequest.Mode.init(rawValue:)) else { return nil }
        let facing = params["facing"]?.stringValue.flatMap(CameraCaptureRequest.Facing.init(rawValue:))
        let maxDuration = params["maxDurationMs"]?.int64Value.map { TimeInterval($0) / 1000 }
        if mode == .photo, maxDuration != nil { return nil }
        return CameraCaptureRequest(mode: mode, facing: facing, maxDuration: maxDuration)
    }

    public func start(_ op: DeviceOperation) {
        guard let request = Self.request(from: op.request.params) else {
            op.fail(.invalidParams, "camera.capture params")
            return
        }
        guard capturer.isAvailable(facing: request.facing) else {
            op.fail(.unavailable, "no-camera")
            return
        }
        let needed: [DevicePermission] = request.mode == .video ? [.camera, .microphone] : [.camera]
        for permission in needed {
            if authority.missingUsageDescription(for: permission) != nil {
                op.fail(.unavailable, "not-declared:\(permission.rawValue)")
                return
            }
        }
        DevicePermissionFlow.ensure(needed, authority: authority, op: op) { [weak self] in
            self?.present(op, request)
        }
    }

    private func present(_ op: DeviceOperation, _ request: CameraCaptureRequest) {
        guard !op.isSettled else { return }
        if let blocked = op.acquirePrompt() {
            op.fail(blocked)
            return
        }
        op.progress(.pendingConsent)
        let handle = capturer.presentCapture(request, maxItemBytes: op.policy.maxItemBytes, captured: {
            op.releasePrompt()
            op.markUserChoiceMade()
            op.progress(.running)
        }) { outcome in
            op.releasePrompt()
            switch outcome {
            case let .captured(media):
                guard DevicePayloads.blobStartViolation("camera.capture", params: op.request.params,
                                                        contentType: media.contentType) == nil else {
                    op.fail(.internal, "capture type does not fit the mode")
                    return
                }
                if op.progressState != .running { op.progress(.running) }
                op.succeed([:], blobs: [DeviceBlob(contentType: media.contentType, bytes: media.data, declaresSize: true)])
            case .dismissed:
                op.fail(.cancelled, "capture-dismissed")
            case .tooLarge:
                op.fail(.throttled, "item exceeds size limit")
            case .presentationFailed:
                op.fail(.unavailable, "presentation-failed")
            case let .failed(detail):
                op.fail(.internal, detail)
            }
        }
        guard let presented = handle else {
            op.releasePrompt()
            op.fail(.unavailable, "no-presenter")
            return
        }
        op.onCancel { presented.cancel() }
    }
}

/// Platform permission flow for capture drivers: an already-denied
/// permission is `denied` (detail = its name) without prompting; an
/// undetermined one is requested through the OS prompt, one at a time under
/// the app-wide prompt gate.
@MainActor
enum DevicePermissionFlow {
    static func ensure(_ permissions: [DevicePermission], authority: DevicePermissionAuthority,
                       op: DeviceOperation, then proceed: @escaping @MainActor () -> Void) {
        guard !op.isSettled else { return }
        guard let permission = permissions.first else {
            proceed()
            return
        }
        let rest = Array(permissions.dropFirst())
        authority.status(of: permission) { status in
            guard !op.isSettled else { return }
            switch status {
            case .granted:
                ensure(rest, authority: authority, op: op, then: proceed)
            case .denied:
                op.fail(.denied, permission.rawValue)
            case .prompt:
                if let blocked = op.acquirePrompt() {
                    op.fail(blocked)
                    return
                }
                authority.request(permission) { result in
                    guard !op.isSettled else { return }
                    op.releasePrompt()
                    switch result {
                    case .granted:
                        ensure(rest, authority: authority, op: op, then: proceed)
                    case .denied, .prompt:
                        op.fail(.denied, permission.rawValue)
                    }
                }
            }
        }
    }
}

// MARK: - mic.record backend

public struct AudioCaptureFormat: Sendable, Equatable {
    /// Output rate in Hz (8000...192000).
    public let sampleRate: Int
    /// 1 (mono) or 2 (interleaved stereo).
    public let channels: Int

    public init(sampleRate: Int, channels: Int) {
        self.sampleRate = sampleRate
        self.channels = channels
    }

    /// Bytes per PCM16 frame (one sample per channel).
    public var frameBytes: Int { 2 * channels }
}

public enum AudioCaptureEvent: Sendable, Equatable {
    /// Captured audio converted to the requested format: little-endian PCM16,
    /// interleaved when stereo, a whole number of frames.
    case samples(Data)
    /// The OS interrupted capture (call, Siri, route loss): the recording
    /// ends normally with what was captured.
    case interrupted
    /// Capture failed; a fixed diagnostic token.
    case failed(String)
}

/// A live microphone source (AVAudioEngine input tap + AVAudioConverter on iOS).
@MainActor
public protocol AudioCaptureSource: AnyObject {
    /// Start capturing in `format`; events flow to `handler` until `stop()`.
    /// Returns a diagnostic token when capture cannot start.
    func start(_ format: AudioCaptureFormat,
               _ handler: @escaping @Sendable @MainActor (AudioCaptureEvent) -> Void) -> String?
    /// Stop and release the hardware. No event is delivered afterwards.
    func stop()
}

@MainActor
public protocol AudioCaptureFactory: AnyObject, Sendable {
    func makeSource() -> AudioCaptureSource
}

// MARK: - mic.record

/// `mic.record@1` (C3; stream, binary upload, undeclared size): host consent
/// naming the origin, the OS microphone permission when undetermined, then an
/// always-visible host recording indicator with Stop for the whole recording
/// (RFC 001 §5; no indicator → `unavailable`). One `audio/L16` item without a
/// declared size; frames of little-endian PCM16 (interleaved when stereo) are
/// sent as captured, paced by credit. Overflow `pause` is bounded: while
/// credit is exhausted captured bytes queue up to `bufferLimit`, past which
/// the recording ends `throttled` (`capture-buffer-full`). Stop, reaching
/// `maxDurationMs`, an OS interruption or host suspension end the recording
/// normally: a success `{durationMs, item}` with what was captured.
@MainActor
public final class MicRecordDriver: DeviceDriver {
    public static let activityLabel = "Recording audio from your microphone"
    public static let contentType = "audio/L16"
    public static let defaultBufferLimit = 1024 * 1024

    public let capability = "mic.record"
    private let factory: AudioCaptureFactory
    private let authority: DevicePermissionAuthority
    private let presenter: DeviceConsentPresenter
    private let indicator: DeviceActivityIndicator
    /// Captured bytes allowed to wait for credit before `throttled`.
    public let bufferLimit: Int

    public init(factory: AudioCaptureFactory,
                authority: DevicePermissionAuthority,
                presenter: DeviceConsentPresenter,
                indicator: DeviceActivityIndicator,
                bufferLimit: Int = MicRecordDriver.defaultBufferLimit) {
        self.factory = factory
        self.authority = authority
        self.presenter = presenter
        self.indicator = indicator
        self.bufferLimit = max(DeviceProtocolConstants.maxBulkChunkBytes, bufferLimit)
    }

    /// Whole-millisecond duration of `frames` at `rate` (rounded, like the
    /// web encoder).
    public static func durationMs(frames: UInt64, sampleRate: Int) -> Int64 {
        guard sampleRate > 0 else { return 0 }
        return Int64((Double(frames) * 1000 / Double(sampleRate)).rounded())
    }

    public func start(_ op: DeviceOperation) {
        let params = op.request.params
        guard let rate = params["sampleRate"]?.int64Value else {
            op.fail(.invalidParams, "sampleRate")
            return
        }
        let format = AudioCaptureFormat(sampleRate: Int(rate), channels: Int(params["channels"]?.int64Value ?? 1))
        let maxFrames: UInt64? = params["maxDurationMs"]?.int64Value.map {
            UInt64((Double($0) * Double(rate) / 1000).rounded(.up))
        }
        if authority.missingUsageDescription(for: .microphone) != nil {
            op.fail(.unavailable, "not-declared:\(DevicePermission.microphone.rawValue)")
            return
        }
        let authority = self.authority
        authority.status(of: .microphone) { [weak self] status in
            guard let self = self, !op.isSettled else { return }
            if status == .denied {
                op.fail(.denied, "microphone")
                return
            }
            if let blocked = op.acquirePrompt() {
                op.fail(blocked)
                return
            }
            op.progress(.pendingConsent)
            let consent = self.presenter.presentConsent(origin: op.displayOrigin,
                                                        operation: Self.consentLabel(format)) { outcome in
                guard !op.isSettled else { return }
                switch outcome {
                case .accepted:
                    break
                case .declined:
                    op.releasePrompt()
                    op.recordDenial()
                    op.fail(.denied, "host-refused")
                    return
                case .unavailable:
                    op.releasePrompt()
                    op.fail(.unavailable, "presentation-failed")
                    return
                }
                op.recordAcceptance()
                // The prompt slot stays held through the OS permission prompt.
                DevicePermissionFlow.ensure([.microphone], authority: authority, op: op) { [weak self] in
                    self?.record(op, format: format, maxFrames: maxFrames)
                }
            }
            guard let handle = consent else {
                op.releasePrompt()
                op.fail(.unavailable, "no-presenter")
                return
            }
            op.onCancel { handle.cancel() }
        }
    }

    static func consentLabel(_ format: AudioCaptureFormat) -> String {
        "record audio from your microphone (\(format.channels == 2 ? "stereo" : "mono"), \(format.sampleRate) Hz)"
    }

    private func record(_ op: DeviceOperation, format: AudioCaptureFormat, maxFrames: UInt64?) {
        guard !op.isSettled else { return }
        // Consent and permission are done: the indicator is not a prompt.
        op.releasePrompt()
        let state = RecordState()
        let stopHardware: @MainActor () -> Void = {
            guard !state.stopped else { return }
            state.stopped = true
            state.source?.stop()
            state.source = nil
            state.indicator?.cancel()
            state.indicator = nil
        }
        // Stop is success: end the item with what was captured.
        let finish: @MainActor () -> Void = {
            guard !op.isSettled else {
                stopHardware()
                return
            }
            stopHardware()
            state.writer?.finish()
            let frames = state.captured / UInt64(format.frameBytes)
            op.succeed(["durationMs": .int(Self.durationMs(frames: frames, sampleRate: format.sampleRate))])
        }
        op.onEnd(stopHardware)
        // Always-visible indicator with Stop for the whole recording (§5).
        guard let visible = indicator.showIndicator(origin: op.displayOrigin, activity: Self.activityLabel, stop: {
            finish()
        }) else {
            op.fail(.unavailable, "no-activity-indicator")
            return
        }
        state.indicator = visible
        // Background / suspension stops the recording (a normal end).
        op.onSuspend { finish() }
        op.progress(.running)
        guard let writer = op.openBlob(contentType: Self.contentType) else {
            stopHardware()
            return
        }
        state.writer = writer
        // The microphone opens only once the indicator is visible.
        let source = factory.makeSource()
        state.source = source
        let limitBytes: UInt64? = maxFrames.map { $0 * UInt64(format.frameBytes) }
        let bufferLimit = self.bufferLimit
        let failure = source.start(format) { event in
            guard !op.isSettled, !state.stopped else { return }
            switch event {
            case let .samples(data):
                var chunk = data
                // Whole frames only.
                let whole = chunk.count - chunk.count % format.frameBytes
                if whole != chunk.count { chunk = chunk.prefix(whole) }
                if let limit = limitBytes {
                    let room = limit - min(limit, state.captured)
                    if UInt64(chunk.count) > room { chunk = chunk.prefix(Int(room)) }
                }
                if !chunk.isEmpty {
                    state.captured += UInt64(chunk.count)
                    writer.write(chunk)
                    guard !op.isSettled else { return }
                    if writer.pendingBytes > bufferLimit {
                        // Starved of credit past the bounded window (§2.4).
                        stopHardware()
                        op.fail(.throttled, "capture-buffer-full")
                        return
                    }
                }
                if let limit = limitBytes, state.captured >= limit { finish() }
            case .interrupted:
                finish()
            case let .failed(detail):
                stopHardware()
                op.fail(.internal, detail)
            }
        }
        if let failure = failure {
            stopHardware()
            op.fail(.unavailable, failure)
        }
    }
}

@MainActor
private final class RecordState {
    var source: AudioCaptureSource?
    var captured: UInt64 = 0
    var stopped = false
    var indicator: DeviceCancellable?
    var writer: DeviceBlobWriter?
}

/// PCM16 helpers shared by audio backends.
public enum DevicePCM16 {
    /// Float samples (interleaved, nominal −1...1) to little-endian PCM16,
    /// clamped, rounding to nearest.
    public static func encode(interleaved samples: [Float]) -> Data {
        var out = Data(capacity: samples.count * 2)
        for sample in samples {
            let clamped = max(-1, min(1, sample.isNaN ? 0 : sample))
            let value = Int16(clamped < 0 ? (clamped * 32768).rounded() : (clamped * 32767).rounded())
            let bits = UInt16(bitPattern: value)
            out.append(UInt8(bits & 0xFF))
            out.append(UInt8(bits >> 8))
        }
        return out
    }

    /// Native Int16 samples (interleaved) as little-endian bytes.
    public static func littleEndianBytes(_ samples: UnsafeBufferPointer<Int16>) -> Data {
        var out = Data(capacity: samples.count * 2)
        for sample in samples {
            let bits = UInt16(bitPattern: sample)
            out.append(UInt8(bits & 0xFF))
            out.append(UInt8(bits >> 8))
        }
        return out
    }
}

// MARK: - bluetooth.select backend

/// One device the chooser lists (identity + signal for ordering).
public struct BluetoothChooserEntry: Sendable, Equatable {
    public let id: String
    public let name: String?
    public let rssi: Int

    public init(id: String, name: String?, rssi: Int) {
        self.id = id
        self.name = name
        self.rssi = rssi
    }
}

public enum BluetoothChooserOutcome: Sendable, Equatable {
    case selected(id: String)
    /// Cancel or dismissal: `cancelled`.
    case dismissed
    /// The chooser could not be shown after all.
    case unavailable
}

/// An open host-owned chooser listing a live scan.
@MainActor
public protocol BluetoothChooserSession: DeviceCancellable {
    /// Replace the listed devices (strongest signal first).
    func update(_ entries: [BluetoothChooserEntry])
}

/// A host-owned chooser (outside the patch tree) naming the origin, with a
/// live device list and Cancel; the per-use gate for `bluetooth.select`.
@MainActor
public protocol BluetoothChooser: AnyObject, Sendable {
    /// Present; nil when it cannot be shown. `completion` runs at most once.
    func presentChooser(origin: String,
                        completion: @escaping @Sendable @MainActor (BluetoothChooserOutcome) -> Void) -> BluetoothChooserSession?
}

// MARK: - bluetooth.select

/// Bluetooth UUID forms. The wire form (`bluetooth.select@1` `services`) is
/// the canonical lowercase 128-bit UUID; OS APIs also report the 16- and
/// 32-bit short forms of SIG-assigned UUIDs (CoreBluetooth's `"180D"`).
public enum DeviceBluetoothUUID {
    /// Suffix of the Bluetooth Base UUID after the leading 32 bits.
    public static let baseSuffix = "-0000-1000-8000-00805f9b34fb"

    /// The canonical lowercase 128-bit form of a 16-bit (`180d`, `0x180d`),
    /// 32-bit or 128-bit UUID in any letter case; nil when not a UUID.
    public static func canonical(_ raw: String) -> String? {
        var text = raw.lowercased()
        let prefixed = text.hasPrefix("0x")
        if prefixed { text.removeFirst(2) }
        let isHex: (Character) -> Bool = { $0.isASCII && $0.isHexDigit }
        switch text.count {
        case 4 where text.allSatisfy(isHex):
            return "0000" + text + baseSuffix
        case 8 where text.allSatisfy(isHex):
            return text + baseSuffix
        case 36 where !prefixed:
            return DevicePayloads.isCanonicalUUID(text) ? text : nil
        default:
            return nil
        }
    }
}

/// `bluetooth.select@1` (C4; unary, no data plane): a host-owned chooser
/// lists a live BLE scan filtered by `services` (the scan's service filter)
/// and `namePrefix` (exact code points); the chooser is the per-use gate and
/// the visible UI with Cancel while the scan runs. The result is identity
/// only: `{device: {id, name?}}`.
@MainActor
public final class BluetoothSelectDriver: DeviceDriver {
    public let capability = "bluetooth.select"
    private let factory: BluetoothScannerFactory
    private let chooser: BluetoothChooser
    /// Most devices listed at once.
    public static let maxListed = 64

    public init(factory: BluetoothScannerFactory, chooser: BluetoothChooser) {
        self.factory = factory
        self.chooser = chooser
    }

    public func start(_ op: DeviceOperation) {
        let services = op.request.params["services"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        let wanted = Set(services.compactMap(DeviceBluetoothUUID.canonical))
        let prefix = op.request.params["namePrefix"]?.stringValue
        if factory.missingUsageDescription != nil {
            op.fail(.unavailable, "not-declared:\(DevicePermission.bluetooth.rawValue)")
            return
        }
        if factory.authorization == .denied {
            op.fail(.denied, "bluetooth")
            return
        }
        if let blocked = op.acquirePrompt() {
            op.fail(blocked)
            return
        }
        op.progress(.pendingConsent)
        let scanner = factory.makeScanner(services: services)
        let state = SelectState()
        let stopAll: @MainActor () -> Void = {
            guard !state.stopped else { return }
            state.stopped = true
            scanner.stop()
            state.session?.cancel()
            state.session = nil
        }
        op.onEnd(stopAll)
        let session = chooser.presentChooser(origin: op.displayOrigin) { outcome in
            guard !op.isSettled else { return }
            // Every ending closes the chooser (`stopAll`), also after a
            // selection the chooser reported itself.
            switch outcome {
            case let .selected(id):
                guard let entry = state.devices[id] else {
                    stopAll()
                    op.fail(.internal, "unknown-device")
                    return
                }
                stopAll()
                var device: DeviceJSONObject = ["id": .string(entry.id)]
                if let name = entry.name { device["name"] = .string(name) }
                op.succeed(["device": .object(device)])
            case .dismissed:
                stopAll()
                op.fail(.cancelled, "chooser-dismissed")
            case .unavailable:
                stopAll()
                op.fail(.unavailable, "presentation-failed")
            }
        }
        guard let open = session else {
            stopAll()
            op.fail(.unavailable, "no-presenter")
            return
        }
        state.session = open
        scanner.start { update in
            guard !op.isSettled, !state.stopped else { return }
            switch update {
            case .scanning:
                break
            case let .discovered(id, name, rssi, advertised):
                let id = DeviceCaptureSupport.bounded(id, 128)
                guard !id.isEmpty else { return }
                // The scan was asked to filter by `services`; a backend that
                // widened it (or cannot say what a device advertises) must
                // not put a non-matching device in front of the user.
                if !wanted.isEmpty {
                    guard let advertised = advertised,
                          advertised.contains(where: { DeviceBluetoothUUID.canonical($0).map(wanted.contains) == true })
                    else { return }
                }
                let name = name.map { DeviceCaptureSupport.bounded($0, 256) }
                if let prefix = prefix {
                    guard let name = name, DeviceCaptureSupport.hasPrefix(name, prefix) else { return }
                }
                if state.devices[id] == nil, state.devices.count >= Self.maxListed { return }
                state.devices[id] = BluetoothChooserEntry(id: id, name: name, rssi: rssi)
                state.session?.update(state.devices.values.sorted {
                    $0.rssi != $1.rssi ? $0.rssi > $1.rssi : $0.id < $1.id
                })
            case .poweredOff:
                stopAll()
                op.fail(.unavailable, "powered-off")
            case .unsupported:
                stopAll()
                op.fail(.unavailable, "unsupported-hardware")
            case .unauthorized:
                stopAll()
                op.fail(.denied, "bluetooth")
            }
        }
    }
}

@MainActor
private final class SelectState {
    var devices: [String: BluetoothChooserEntry] = [:]
    var session: BluetoothChooserSession?
    var stopped = false
}

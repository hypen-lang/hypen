import Foundation

// Device Capability Protocol — native DeviceHost core (RFC 001 §2, §2.6,
// §2.7, §5). Swift port of the TS client runtime
// (`hypen-web/packages/core/src/remote/device/runtime.ts`) plus the host
// policy of `@hypen-space/device-web`.
//
// The host is separate from the renderer (which stays a pure patch
// consumer). `RemoteEngine` owns the socket and feeds the host through the
// `DeviceEndpoint` contract; the host owns drivers, admission (one prompt at
// a time, denial cooldowns, deadline clamp), leases, cancellation, blob
// upload scheduling, download receipt, and teardown. Everything here is
// platform-agnostic: UIKit / Photos / CoreBluetooth live behind the driver
// backend protocols in `DeviceDrivers.swift`, implemented in
// `DeviceHostIOS.swift`.
//
// Inbound handling follows the shared rules (RFC 001 §2.1, decisions D3/D4/D8,
// pinned by `engine-compatibility-tests/fixtures/device/transcripts/`):
//
// - text breaking the JSON limits, or without a device `type` and a u32 `id`,
//   is attributable to no request: it is discarded and counted as a
//   connection-level violation (the connection is closed only after
//   `Options.maxConnectionViolations` of them), exactly like a frame header
//   with an unknown version or nonzero flags;
// - a message for an id that is not live is ignored whatever its direction
//   or validity (liveness is checked before direction);
// - any other violation on a live id (malformed shape, wrong direction,
//   credit, lease sequence, owner, payload) terminates that request with
//   `invalidParams`; a request for a revision outside the live selection
//   (or the registry) is refused with `unsupported`;
// - an app request before the connection-owned `core.capabilities` stream,
//   or a second live core stream, breaks the connection's control plane:
//   the device connection is closed.

private let log = HypenLoggers.remote.child("Device")

// MARK: - Transport / endpoint contracts

/// What the host needs from the socket to reply to the server. Device
/// messages use a dedicated route, never the UI `dispatchAction` path (§5).
@MainActor
public protocol DeviceTransport: AnyObject {
    /// Send one JSON device message (deviceResponse / deviceEvent) as a text frame.
    func sendDeviceMessage(_ json: Data)
    /// Send one binary frame; `completion` runs once the transport has taken
    /// the bytes (used for the §2.3 pending-bytes bound).
    func sendDeviceBinary(_ frame: Data, completion: @escaping @Sendable @MainActor () -> Void)
    /// The origin (`scheme://host[:port]`) of the socket this transport
    /// writes to, or nil when unknown. A host bound to an origin refuses a
    /// transport whose socket talks to another one (§5: prompts and grants
    /// name the server the socket actually reaches).
    var socketOrigin: String? { get }
    /// Close the physical connection: the device control plane broke
    /// (missing or duplicated `core.capabilities` stream) or the peer kept
    /// sending connection-level violations.
    func closeDeviceConnection(code: Int, reason: String)
}

extension DeviceTransport {
    public var socketOrigin: String? { nil }
    public func closeDeviceConnection(code: Int, reason: String) {}
}

/// The contract a client engine uses to plug in a DeviceHost (mirrors the TS
/// `DeviceEndpoint`). The engine owns the socket; the endpoint owns consent,
/// drivers and teardown.
@MainActor
public protocol DeviceEndpoint: AnyObject {
    /// Complete initial advertisement carried in `hello.device` (§2.2).
    var advertisement: DeviceHello { get }
    /// Socket opened: the endpoint may reply through `transport` from now
    /// on. Returns false when the endpoint refuses this socket (e.g. its
    /// origin differs from the one the host is bound to); the engine then
    /// keeps the device plane off (no `hello.device`).
    @discardableResult
    func attach(_ transport: DeviceTransport) -> Bool
    /// Handshake outcome: `sessionAck.device`, or nil when the ack carried
    /// none (not selected yet — a later ack may still carry it, D6).
    func onAck(_ ack: DeviceAck?)
    /// Server → client device message (`deviceRequest` / `deviceEvent` /
    /// a misdirected `deviceResponse`), raw JSON text.
    func handleMessage(_ json: Data)
    /// Server → client binary frame.
    func handleFrame(_ frame: Data)
    /// Socket closed: stop every operation, release hardware, dismiss prompts.
    func detach()
}

// MARK: - Drivers

/// One produced upload item with its bytes in hand. The host allocates
/// channels in order. Frames are cut lazily from `bytes` per scheduling turn
/// (never pre-materialised), so a memory-mapped `Data` stays mapped (§5
/// "bound … binary buffers").
public struct DeviceBlob: Sendable {
    public let contentType: String
    public let bytes: Data
    /// Whether `blobStart` declares the size (RFC 001 §2.4, decision D5).
    /// A sender that knows the size should declare it; the item's terminal
    /// entry always states the actual byte count and SHA-256.
    public let declaresSize: Bool
    /// Extra members of this item's terminal entry (e.g. `file.pick`'s
    /// `name`); never part of `blobStart`.
    public let itemFields: DeviceJSONObject

    public init(contentType: String, bytes: Data, declaresSize: Bool = true,
                itemFields: DeviceJSONObject = [:]) {
        self.contentType = contentType
        self.bytes = bytes
        self.declaresSize = declaresSize
        self.itemFields = itemFields
    }
}

/// A capability driver. `start` is called once per admitted request; the
/// driver finishes it through `operation.succeed` / `operation.fail`, emits
/// stream events through `operation.emit`, streams live items through
/// `operation.openBlob`, and registers cleanup through `operation.onCancel`
/// / `operation.onEnd`.
@MainActor
public protocol DeviceDriver: AnyObject {
    var capability: String { get }
    func start(_ operation: DeviceOperation)
}

// MARK: - Streamed upload items (D5)

/// A live upload item whose size is not known upfront (microphone capture,
/// a picker item being transcoded). Opened with `DeviceOperation.openBlob`,
/// which announces `blobStart` (with `bytes` only when declared); bytes
/// written here are framed as credit allows; `finish()` ends the item. The
/// host enforces the revision's `maxItemBytes` as bytes are written.
@MainActor
public final class DeviceBlobWriter {
    public let channel: UInt16
    weak var operation: DeviceOperation?
    let item: DeviceHost.UploadChannel

    init(channel: UInt16, operation: DeviceOperation, item: DeviceHost.UploadChannel) {
        self.channel = channel
        self.operation = operation
        self.item = item
    }

    /// Bytes written but not yet framed onto the wire (waiting for credit
    /// or transport room). A live source bounds its own buffering with it
    /// (overflow `pause` is bounded: past its window a capture ends
    /// `throttled`, never buffering without limit — RFC 001 §2.4).
    public var pendingBytes: Int {
        guard let op = operation, op.phase != .terminal else { return 0 }
        return item.buffered
    }

    /// Bytes written to this item so far.
    public var writtenBytes: UInt64 { item.written }

    /// True once finished or once the operation settled.
    public var isClosed: Bool {
        item.finished || operation == nil || operation?.phase == .terminal
    }

    /// Append bytes to the item. A no-op once closed.
    public func write(_ data: Data) {
        guard !data.isEmpty, !isClosed, let op = operation else { return }
        op.host?.blobWrite(op, item, data)
    }

    /// End the item (its terminal entry is sent once every byte is framed).
    public func finish() {
        guard !isClosed, let op = operation else { return }
        op.host?.blobFinish(op, item)
    }
}

// MARK: - Operation

/// One live request as seen by a driver. Every call is a no-op once the
/// operation is settled (server cancel, deadline, lease expiry, detach), so a
/// late OS callback can never restart or upload cancelled work (§2.1/§2.6).
@MainActor
public final class DeviceOperation {
    enum Phase { case running, uploading, terminal }

    public let request: DeviceRequest
    public let policy: DeviceRevisionPolicy
    /// The authenticated app origin prompts must name (§2.6).
    public let origin: String
    /// `origin` as host UI must show it: plaintext (`ws://`) origins carry a
    /// visible development-mode marker (§5).
    public var displayOrigin: String { grants.displayOrigin }
    public let grants: DeviceGrantStore
    public let clock: DeviceClock
    let promptGate: DevicePromptGate

    weak var host: DeviceHost?
    let epoch: UInt64
    var phase: Phase = .running
    var cancelHandlers: [@MainActor () -> Void] = []
    var endHandlers: [@MainActor () -> Void] = []
    var promptToken: UInt64?
    /// The user already made the choice this operation carries out (e.g. a
    /// picker selection being loaded): host suspension does not discard it.
    var choiceMade = false
    /// Driver-owned reaction to host suspension (e.g. a recording stops and
    /// completes with what it captured) replacing the default cancel.
    var suspendHandler: (@MainActor () -> Void)?
    // Leases (§2.7)
    var leaseSeq: UInt32 = 0
    var leaseExpiresAt: TimeInterval = 0
    var leaseTimer: DeviceCancellable?
    var deadlineAt: TimeInterval = 0
    var deadlineTimer: DeviceCancellable?
    // Upload (§2.3/§2.4)
    var upload: DeviceHost.UploadState?
    // Download (§2.3/§2.4, file.save)
    var download: DeviceHost.DownloadState?
    /// Aggregate data credit: payload bytes for binary uploads, events for
    /// JSON streams (§2.3). `initialCredit` + grants − consumed.
    var credit: UInt64
    var paused = false
    /// JSON stream events produced while event credit was exhausted,
    /// bounded per the revision's overflow policy (`dropOldest`).
    var pendingEvents: [DeviceJSONObject] = []
    // Progress (§2.1)
    var progressState: DeviceProgressState?
    var dataSeen = false

    init(request: DeviceRequest, policy: DeviceRevisionPolicy, host: DeviceHost, epoch: UInt64) {
        self.request = request
        self.policy = policy
        self.origin = host.grants.origin
        self.grants = host.grants
        self.clock = host.clock
        self.promptGate = host.promptGate
        self.host = host
        self.epoch = epoch
        self.credit = request.initialCredit
    }

    /// True once the driver can no longer affect the wire.
    public var isSettled: Bool { phase != .running }

    /// Decode `params` into a closed capability schema; nil on violation
    /// (the driver then fails with `invalidParams`).
    public func params<T: Decodable>(_ type: T.Type) -> T? {
        try? DeviceWire.decode(type, from: request.params)
    }

    /// Emit a capability stream event (`deviceEvent.event`). On a JSON
    /// stream each event spends one unit of event credit (§2.3); with none
    /// left the event is held under the revision's overflow policy until the
    /// server grants more. An event the revision does not define ends the
    /// operation with `internal` (never an invalid message on the wire).
    public func emit(_ event: DeviceJSONObject) {
        guard phase == .running else { return }
        host?.emitEvent(self, event)
    }

    /// Report optional progress (§2.1): credit-free; never goes back to
    /// `pendingConsent` after `running` or after data (such a call is
    /// dropped).
    public func progress(_ state: DeviceProgressState) {
        guard phase == .running else { return }
        host?.emitProgress(self, state)
    }

    /// Terminal success. Blobs are announced (`blobStart`), streamed as
    /// ≤64 KiB frames, then declared in the result's `items` (or `item`)
    /// with SHA-256 (§2.4). Items opened with `openBlob` are finished here.
    /// `simulated` is for fakes only (RFC 001 pillar 11).
    public func succeed(_ result: DeviceJSONObject = [:], blobs: [DeviceBlob] = [], simulated: Bool = false) {
        host?.driverFinished(self, .success(result, blobs, simulated: simulated))
    }

    /// Terminal error.
    public func fail(_ code: DeviceErrorCode, _ detail: String? = nil, simulated: Bool = false) {
        host?.driverFinished(self, .failure(DeviceError(code, detail), simulated: simulated))
    }

    public func fail(_ error: DeviceError) {
        host?.driverFinished(self, .failure(error, simulated: false))
    }

    /// Open a live upload item (binary-upload revisions only), announcing
    /// `blobStart` now. `declaredBytes` is an exact size when the sender
    /// knows it; nil streams an item of unknown length (decision D5). Returns
    /// nil when the operation is settled, the revision has no upload plane,
    /// or the item count limit is reached (the operation then ends
    /// `throttled`).
    public func openBlob(contentType: String, declaredBytes: UInt64? = nil,
                         itemFields: DeviceJSONObject = [:]) -> DeviceBlobWriter? {
        guard phase == .running else { return nil }
        return host?.openBlob(self, contentType: contentType, declaredBytes: declaredBytes,
                              itemFields: itemFields, data: nil)
    }

    /// Run `handler` when the operation is settled by anything other than
    /// the driver itself: server cancel, deadline, lease expiry, host
    /// suspension, or socket teardown — including while its blobs are still
    /// uploading after `succeed(…, blobs:)` (handlers registered before
    /// `succeed` are kept for the upload). Runs immediately if already
    /// settled. Discarded without running when the driver fails or the
    /// operation completes; use `onEnd` for cleanup that must always run.
    public func onCancel(_ handler: @escaping @MainActor () -> Void) {
        if phase == .terminal {
            handler()
        } else {
            cancelHandlers.append(handler)
        }
    }

    /// Run `handler` exactly once when the operation ends for any reason
    /// (success, failure, cancel, teardown): the place to release a resource
    /// backing a `DeviceBlob` (a temp file, a security-scoped URL). Runs
    /// immediately if already ended.
    public func onEnd(_ handler: @escaping @MainActor () -> Void) {
        if phase == .terminal {
            handler()
        } else {
            endHandlers.append(handler)
        }
    }

    /// React to host suspension (backgrounding) yourself instead of being
    /// cancelled: e.g. `mic.record` stops and succeeds with what it captured
    /// (RFC 001 §5: background/suspend stops a recording). The handler must
    /// settle or stop the operation's hardware.
    public func onSuspend(_ handler: @escaping @MainActor () -> Void) {
        guard phase == .running else { return }
        suspendHandler = handler
    }

    /// The user made the choice this operation carries out (e.g. picked
    /// items that are still loading): host suspension (backgrounding) no
    /// longer cancels it, like an operation already uploading.
    public func markUserChoiceMade() {
        guard phase == .running else { return }
        choiceMade = true
    }

    // MARK: Downloads (binaryDownload revisions, e.g. file.save)

    /// Grant the server `bytes` more download credit (§2.3: the receiver
    /// grants, only after consent and destination selection). Clamped to the
    /// revision's outstanding bound; returns the amount actually granted.
    @discardableResult
    public func grantDownload(_ bytes: UInt64) -> UInt64 {
        guard phase == .running else { return 0 }
        return host?.grantDownload(self, bytes) ?? 0
    }

    /// Receive each download chunk, in order, as it arrives.
    public func onDownloadChunk(_ handler: @escaping @MainActor (Data) -> Void) {
        download?.onChunk = handler
    }

    /// Run `handler` once every declared byte arrived and the declared
    /// SHA-256 matched. A driver may succeed only after this.
    public func onDownloadComplete(_ handler: @escaping @MainActor () -> Void) {
        guard let download = download else { return }
        if download.verified {
            handler()
        } else {
            download.onComplete = handler
        }
    }

    /// Admission for a prompt-raising step (§2.6 step 1, §5): denial cooldown,
    /// then one prompt at a time. Returns the `throttled` error to fail with,
    /// or nil once this operation holds the prompt slot.
    public func acquirePrompt() -> DeviceError? {
        guard phase == .running else { return DeviceError(.cancelled) }
        if promptToken != nil { return nil }
        if grants.isCoolingDown(request.capability, now: clock.wallNow) {
            return DeviceError(.throttled, "cooldown")
        }
        guard let token = promptGate.acquire() else {
            return DeviceError(.throttled, "prompt-in-progress")
        }
        promptToken = token
        return nil
    }

    /// Release the prompt slot (the OS/host interaction is gone).
    public func releasePrompt() {
        if let token = promptToken {
            promptGate.release(token)
            promptToken = nil
        }
    }

    /// Host-owned refusal: start/extend the capability's cooldown.
    public func recordDenial() {
        grants.recordDenial(request.capability, now: clock.wallNow)
    }

    /// User accepted a host interaction: reset the refusal backoff.
    public func recordAcceptance() {
        grants.recordAcceptance(request.capability)
    }
}

// MARK: - Host

/// The native DeviceHost protocol core.
@MainActor
public final class DeviceHost: DeviceEndpoint {
    public struct Options: Sendable {
        /// Client-side maximum for any module-owned request deadline;
        /// `timeoutMs` is clamped to `min(timeoutMs, maxTimeout)` from
        /// receipt (§2.1). Connection-owned control streams are exempt.
        public var maxTimeout: TimeInterval
        /// Lease expiry after receipt / the last accepted renewal (§2.7).
        public var leaseExpiry: TimeInterval
        /// Connection-level violations (JSON limits, bad frame headers,
        /// unattributable messages) tolerated before the connection is
        /// closed (decision D3: counted, fatal only when repeated).
        public var maxConnectionViolations: Int

        // Upload credit is always enforced (§2.3): frames are sized to
        // `min(64 KiB, remaining credit)`, and `paused` transitions are
        // reported while the balance is zero.
        public init(maxTimeout: TimeInterval = 600,
                    leaseExpiry: TimeInterval = DeviceProtocolConstants.leaseExpiry,
                    maxConnectionViolations: Int = 32) {
            self.maxTimeout = maxTimeout
            self.leaseExpiry = leaseExpiry
            self.maxConnectionViolations = maxConnectionViolations
        }
    }

    /// One upload item: a queue of written bytes cut lazily into frames.
    final class UploadChannel {
        let index: UInt16
        let contentType: String
        let declared: UInt64?
        let itemFields: DeviceJSONObject
        var chunks: [Data] = []
        var headOffset = 0
        var buffered = 0
        var written: UInt64 = 0
        var sent: UInt64 = 0
        var nextSeq: UInt64 = 0
        var finished = false
        var completed = false
        var hasher = DeviceHasher()
        var item: DeviceJSONObject?

        init(index: UInt16, contentType: String, declared: UInt64?, itemFields: DeviceJSONObject) {
            self.index = index
            self.contentType = contentType
            self.declared = declared
            self.itemFields = itemFields
        }

        /// Cut the next `count` buffered bytes (a slice when they sit in one
        /// chunk, so a memory-mapped item stays mapped).
        func take(_ count: Int) -> Data {
            var payload: Data?
            var remaining = count
            while remaining > 0, let head = chunks.first {
                let start = head.startIndex + headOffset
                let available = head.count - headOffset
                let n = min(available, remaining)
                let slice = head[start..<(start + n)]
                if payload == nil, n == remaining {
                    payload = slice
                } else {
                    if payload == nil { payload = Data(capacity: count) }
                    payload!.append(slice)
                }
                remaining -= n
                headOffset += n
                if headOffset == head.count {
                    chunks.removeFirst()
                    headOffset = 0
                }
            }
            buffered -= count
            return payload ?? Data()
        }
    }

    /// Upload state of one operation (§2.3/§2.4).
    final class UploadState {
        var channels: [UploadChannel] = []
        /// Set once the driver succeeded: the terminal follows the last byte.
        var result: DeviceJSONObject?
        var simulated = false
        let maxChannels: Int

        init(maxChannels: Int) {
            self.maxChannels = maxChannels
        }
    }

    /// Download state of one operation (server → client, file.save).
    final class DownloadState {
        let declared: UInt64
        let sha256: String
        var received: UInt64 = 0
        var sequence = DeviceSequenceTracker()
        var granted: UInt64 = 0
        var credit: UInt64 = 0
        var serverPaused = false
        var hasher = DeviceHasher()
        var verified = false
        var onChunk: (@MainActor (Data) -> Void)?
        var onComplete: (@MainActor () -> Void)?

        init(declared: UInt64, sha256: String) {
            self.declared = declared
            self.sha256 = sha256
        }
    }

    /// What the next scheduling step for an uploading operation is.
    enum UploadStep {
        case frame(UploadChannel, Int)
        case finishItem(UploadChannel)
        case terminal
        case awaitingCredit
    }

    enum Outcome {
        case success(DeviceJSONObject, [DeviceBlob], simulated: Bool)
        case failure(DeviceError, simulated: Bool)
    }

    public let advertisement: DeviceHello
    public let options: Options
    public let clock: DeviceClock
    public let promptGate: DevicePromptGate
    /// Grants and cooldowns for the origin of the attached socket.
    public private(set) var grants: DeviceGrantStore
    /// The origin this host is bound to, when one was configured.
    public let configuredOrigin: String?
    /// The accepted selection for the current socket: `sessionAck.device`
    /// after validation against this host's advertisement (§2.2).
    public private(set) var selected: DeviceAck?

    private let persistentStore: DeviceKeyValueStore
    private var drivers: [String: DeviceDriver] = [:]
    private var transport: DeviceTransport?
    private var epoch: UInt64 = 0
    private var highWater: UInt32 = 0
    private var operations: [UInt32: DeviceOperation] = [:]
    /// An ack carrying `device` was processed on this socket (accepted or
    /// refused); later acks cannot change it (§2.2).
    private var ackProcessed = false
    /// Live selection: the accepted ack filtered by the latest snapshot the
    /// live `core.capabilities` stream sent (§2.2).
    private var liveSelection: [String: UInt32] = [:]
    private var coreOpened = false
    private var coreStreamId: UInt32?
    /// Highest activationId seen per moduleInstanceId (exact bytes).
    private var activations: [[UInt8]: UInt32] = [:]
    private var unavailable: Set<String> = []
    /// The advertisement rule (§2.2) applied to every snapshot, when the
    /// host was built with one (`init(origin:drivers:rule:…)`).
    var advertisementRule: DeviceAdvertisementRule?
    /// The offers of the last snapshot built on this socket, so a rule
    /// re-evaluation publishes only an actual change.
    private var lastSnapshotOffers: [CapabilityOffer]?
    private var connectionViolations = 0
    // Bulk scheduling (§2.3)
    private var bulkOrder: [UInt32] = []
    private var pendingTransportBytes = 0
    private var turnScheduled = false
    /// Platform helpers retained for the host's lifetime (e.g. lifecycle observers).
    var retained: [AnyObject] = []
    /// The connection model's "core.capabilities first" rule. Unit tests of
    /// single behaviours turn it off to address requests without a prelude;
    /// always on in production.
    var requiresCoreStreamFirst = true

    /// - Parameters:
    ///   - origin: the app origin prompts name and grants key on — normally
    ///     the server's `wss://host[:port]` (§5). When set, a socket whose
    ///     origin differs is refused at `attach`; when nil, the host binds to
    ///     each socket's own origin.
    ///   - drivers: capability drivers. `core.capabilities` is always
    ///     provided by the host itself and need not be passed.
    public init(origin: String?,
                drivers: [DeviceDriver],
                options: Options = Options(),
                clock: DeviceClock = SystemDeviceClock(),
                promptGate: DevicePromptGate = DevicePromptGate(),
                persistentStore: DeviceKeyValueStore = UserDefaultsDeviceStore()) {
        self.options = options
        self.clock = clock
        self.promptGate = promptGate
        self.persistentStore = persistentStore
        self.configuredOrigin = origin
        self.grants = DeviceGrantStore(origin: origin ?? "", persistentStore: persistentStore)

        var ordered: [DeviceDriver] = [CoreCapabilitiesDriver()]
        ordered += drivers.filter { $0.capability != CoreCapabilitiesDriver.name }
        var offers: [CapabilityOffer] = []
        for driver in ordered where self.drivers[driver.capability] == nil {
            let versions = DeviceRegistry.revisions
                .filter { $0.capability == driver.capability }
                .map { $0.version }
            // Advertise only implementable, registry-declared revisions (§2.2).
            guard !versions.isEmpty else { continue }
            self.drivers[driver.capability] = driver
            offers.append(CapabilityOffer(name: driver.capability, versions: versions))
        }
        self.advertisement = DeviceHello(
            protocolVersions: [DeviceProtocolConstants.version], binary: true, capabilities: offers)
    }

    /// Live request count (diagnostics/tests).
    public var liveOperationCount: Int { operations.count }

    /// Connection-level violations counted on this socket (diagnostics/tests).
    public var connectionViolationCount: Int { connectionViolations }

    /// The live selection (name → revision) requests are admitted against.
    public var liveCapabilities: [String: UInt32] { liveSelection }

    // MARK: DeviceEndpoint

    @discardableResult
    public func attach(_ transport: DeviceTransport) -> Bool {
        if self.transport != nil { detach() }
        // Bind prompts and grants to the origin the socket actually reaches.
        let socket = transport.socketOrigin
        if let configured = configuredOrigin, let socket = socket,
           !Self.sameOrigin(configured, socket) {
            log.warn("device plane refused: host origin does not match the socket's origin")
            return false
        }
        guard let effective = socket ?? configuredOrigin else {
            log.warn("device plane refused: no origin to bind prompts and grants to")
            return false
        }
        if DeviceGrantStore.normalize(effective) != grants.origin || grants.origin.isEmpty {
            grants = DeviceGrantStore(origin: effective, persistentStore: persistentStore)
        }
        epoch &+= 1
        self.transport = transport
        resetConnectionState()
        return true
    }

    /// Origins compare by scheme family (`https`≡`wss`, `http`≡`ws`), host
    /// and effective port.
    static func sameOrigin(_ a: String, _ b: String) -> Bool {
        func canonical(_ raw: String) -> String {
            let normalized = DeviceGrantStore.normalize(raw)
            for (from, to) in [("https://", "wss://"), ("http://", "ws://")] where normalized.hasPrefix(from) {
                return to + normalized.dropFirst(from.count)
            }
            return normalized
        }
        return canonical(a) == canonical(b)
    }

    private func resetConnectionState() {
        highWater = 0
        selected = nil
        ackProcessed = false
        liveSelection = [:]
        coreOpened = false
        coreStreamId = nil
        activations = [:]
        connectionViolations = 0
        lastSnapshotOffers = nil
    }

    public func onAck(_ ack: DeviceAck?) {
        guard transport != nil else { return }
        // No `device` yet: not selected, not disabled for good (D6).
        guard let ack = ack else {
            if selected == nil { log.debug("sessionAck without device: device plane not selected (yet)") }
            return
        }
        // Once processed, the handshake is immutable for that socket (§2.2).
        guard !ackProcessed else {
            if ack != selected { log.warn("ignoring changed sessionAck.device on this socket") }
            return
        }
        ackProcessed = true
        guard let accepted = accept(ack) else { return }
        selected = accepted
        liveSelection = Dictionary(accepted.capabilities.map { ($0.name, $0.version) },
                                   uniquingKeysWith: { first, _ in first })
    }

    /// Validate the server's selection against this host's advertisement
    /// (§2.2): a common protocol version and `core.capabilities@1` are
    /// required (else the device plane stays off); an entry naming a
    /// revision this host never offered, or a binary-plane revision without
    /// negotiated binary, is dropped and never enabled.
    func accept(_ ack: DeviceAck) -> DeviceAck? {
        Self.acceptSelection(ack, advertisement: advertisement)
    }

    /// `accept(_:)` against an explicit advertisement (the exact
    /// `hello.device` this connection sent). Pinned by
    /// `conformance/selection.json`: every server selection there passes
    /// unchanged, and every disabled case yields nil.
    nonisolated static func acceptSelection(_ ack: DeviceAck, advertisement: DeviceHello) -> DeviceAck? {
        guard advertisement.protocolVersions.contains(ack.protocolVersion) else {
            log.warn("device plane disabled: no common protocol version")
            return nil
        }
        guard !DeviceWire.hasDuplicateNames(ack.capabilities.map { $0.name }) else {
            log.warn("device plane disabled: sessionAck.device names a capability twice")
            return nil
        }
        let binary = ack.binary && advertisement.binary
        var kept: [CapabilitySelection] = []
        for selection in ack.capabilities {
            let offered = advertisement.capabilities.first { DeviceWire.sameName($0.name, selection.name) }
            guard let offer = offered, offer.versions.contains(selection.version) else {
                log.warn("ignoring a selection this host never offered")
                continue
            }
            let plane = DeviceRegistry.find(offer.name, version: selection.version)?.data
            if !binary, plane == .binaryUpload || plane == .binaryDownload {
                log.warn("ignoring a binary-plane selection without negotiated binary")
                continue
            }
            kept.append(CapabilitySelection(name: offer.name, version: selection.version))
        }
        guard kept.contains(where: { DeviceWire.sameName($0.name, "core.capabilities") && $0.version == 1 }) else {
            log.warn("device plane disabled: the server did not select core.capabilities@1")
            return nil
        }
        return DeviceAck(protocolVersion: ack.protocolVersion, binary: binary, capabilities: kept)
    }

    public func handleMessage(_ json: Data) {
        // No device traffic before selection completes (§2.2).
        guard transport != nil, selected != nil else { return }
        // JSON limits first (§2.1, D4): text breaking them names no request.
        let value: DeviceJSON
        do {
            value = try DeviceStrictJSON.parse(json)
        } catch {
            connectionViolation("device message breaks the JSON limits")
            return
        }
        guard case let .object(fields) = value,
              case let .string(type)? = fields["type"],
              case let .int(rawId)? = fields["id"],
              rawId >= 1, rawId <= Int64(UInt32.max) else {
            connectionViolation("device message without a device type and id")
            return
        }
        let id = UInt32(rawId)
        switch type {
        case DeviceRequest.wireType: handleRequest(value, id: id)
        case DeviceEvent.wireType: handleEvent(value, id: id)
        case DeviceResponse.wireType:
            // Only the client sends deviceResponse: on a live id it is a
            // known-id violation (D8); otherwise it is ignored.
            if let op = operations[id] {
                settle(op, reply: DeviceError(.invalidParams, "deviceResponse from the server"))
            }
        default:
            connectionViolation("unknown device message type")
        }
    }

    public func handleFrame(_ frame: Data) {
        guard transport != nil, selected != nil else { return }
        switch DeviceFrameCodec.decode(frame) {
        case .failure(.shortHeader):
            return // droppable (§2.3)
        case .failure(.violation):
            // Unknown version / nonzero flags (D3): the header is untrusted,
            // so no request is terminated; counted as connection-level.
            connectionViolation("bad device frame header")
        case let .success(decoded):
            // Unknown ids drop without allocation (liveness before direction).
            guard let op = operations[decoded.header.requestId] else { return }
            guard op.policy.data == .binaryDownload else {
                settle(op, reply: DeviceError(.invalidParams, "frame against the data direction"))
                return
            }
            receiveDownloadFrame(op, decoded)
        }
    }

    public func detach() {
        guard transport != nil || !operations.isEmpty else { return }
        epoch &+= 1
        transport = nil
        resetConnectionState()
        let live = Array(operations.values)
        operations.removeAll()
        bulkOrder.removeAll()
        pendingTransportBytes = 0
        for op in live {
            // Connection loss: stop everything, send nothing (§2.5).
            retire(op)
        }
        grants.resetConnectionScoped()
    }

    // MARK: Connection-level violations (D3)

    private func connectionViolation(_ reason: String) {
        connectionViolations += 1
        if connectionViolations <= 4 || connectionViolations % 64 == 0 {
            log.debug("device protocol violation #\(connectionViolations): \(reason)")
        }
        if connectionViolations >= options.maxConnectionViolations {
            closeConnection(code: 1002, reason: "device protocol violation")
        }
    }

    /// The device connection's control plane broke (§2.2): close it.
    private func closeConnection(code: Int, reason: String) {
        guard let transport = transport else { return }
        log.warn("closing the device connection: \(reason)")
        detach()
        transport.closeDeviceConnection(code: code, reason: reason)
    }

    // MARK: Host-local policy

    /// Host-local app suspension (§2.7): stops activation-bound hardware and
    /// pending prompts; connection-owned control streams continue.
    ///
    /// Operations whose user choice is already made — uploading their
    /// result, or loading picked items (`markUserChoiceMade`) — are exempt:
    /// no hardware or prompt is involved, so a brief backgrounding does not
    /// discard the choice.
    public func suspend() {
        for op in Array(operations.values)
        where op.request.lifetime == .activation && op.phase != .uploading && !op.choiceMade {
            if let handler = op.suspendHandler {
                op.suspendHandler = nil
                handler()
            } else {
                settle(op, reply: DeviceError(.cancelled, "host-suspended"))
            }
        }
    }

    /// Mark a capability (un)available (hardware attached/detached,
    /// permission changed) and publish a fresh snapshot on the live
    /// `core.capabilities` stream. `core.capabilities` is always available.
    public func setAvailable(_ capability: String, _ available: Bool) {
        guard capability != CoreCapabilitiesDriver.name else { return }
        let changed = available ? unavailable.remove(capability) != nil : unavailable.insert(capability).inserted
        if changed { publishCapabilities() }
    }

    /// Replace the whole set of unavailable capabilities at once (one
    /// snapshot for the change). `core.capabilities` is always available.
    public func setUnavailable(_ capabilities: Set<String>) {
        let next = capabilities.subtracting([CoreCapabilitiesDriver.name])
        guard next != unavailable else { return }
        unavailable = next
        publishCapabilities()
    }

    /// The current advertisement: the initial one minus unavailable
    /// capabilities and minus what the advertisement rule withholds now
    /// (hardware absent, indicator not showable; §2.2).
    public var currentOffers: [CapabilityOffer] {
        advertisement.capabilities.filter {
            !unavailable.contains($0.name) && (advertisementRule?.isAdvertised($0.name) ?? true)
        }
    }

    /// Emit a fresh full advertisement on every live `core.capabilities`
    /// stream (e.g. after a hardware/permission change).
    public func publishCapabilities() {
        let offers = snapshotOffers()
        for op in operations.values where op.request.capability == CoreCapabilitiesDriver.name {
            op.emit(CoreCapabilitiesDriver.snapshot(offers))
        }
    }

    /// Re-evaluate the advertisement rule and publish a fresh snapshot iff
    /// the offers differ from the last snapshot built on this socket (the
    /// rule's inputs changed: indicator shown/hidden, foreground scene
    /// gained/lost, hardware attached/detached).
    public func refreshAdvertisement() {
        guard let last = lastSnapshotOffers, last != currentOffers else { return }
        publishCapabilities()
    }

    /// `currentOffers`, remembered as the latest snapshot content.
    func snapshotOffers() -> [CapabilityOffer] {
        let offers = currentOffers
        lastSnapshotOffers = offers
        return offers
    }

    // MARK: Requests

    private func handleRequest(_ value: DeviceJSON, id: UInt32) {
        // Never reused on a connection: duplicates/older ids drop without
        // executing again (§2.1).
        guard id > highWater else { return }
        highWater = id

        let request: DeviceRequest
        do {
            request = try DeviceWire.decode(DeviceRequest.self, from: value)
        } catch {
            // Attributable (a new id): a known-id invalid message (D8).
            sendResponse(DeviceResponse(id: id, error: DeviceError(.invalidParams, "malformed deviceRequest")))
            return
        }
        // Connection model (§2.2): the connection-owned control stream opens
        // first, and at most one is live.
        let isCore = DeviceWire.sameName(request.capability, CoreCapabilitiesDriver.name)
        if isCore {
            if let live = coreStreamId, operations[live] != nil {
                closeConnection(code: 1002, reason: "a second live core.capabilities stream")
                return
            }
        } else if !coreOpened, requiresCoreStreamFirst {
            closeConnection(code: 1002, reason: "app request before core.capabilities opened")
            return
        }
        guard let policy = DeviceRegistry.find(request.capability, version: request.version),
              isCore || liveSelection[request.capability] == request.version,
              let driver = drivers[request.capability] else {
            sendResponse(DeviceResponse(id: id, error: DeviceError(.unsupported)))
            return
        }
        // activationIds never go backwards per module instance: an older one
        // would resurrect swept authority (§2.7).
        if case let .activation(moduleInstanceId, activationId) = request.owner {
            let key = Array(moduleInstanceId.utf8)
            if let seen = activations[key], activationId < seen {
                sendResponse(DeviceResponse(id: id, error: DeviceError(.invalidParams, "activationId went backwards")))
                return
            }
            activations[key] = activationId
        }
        if let violation = Self.validate(request, against: policy)
            ?? DevicePayloads.validate(request.capability, version: request.version,
                                       kind: .params, value: .object(request.params)) {
            sendResponse(DeviceResponse(id: id, error: DeviceError(.invalidParams, violation)))
            return
        }

        let op = DeviceOperation(request: request, policy: policy, host: self, epoch: epoch)
        operations[id] = op
        if isCore {
            coreOpened = true
            coreStreamId = id
        }
        if policy.data == .binaryDownload,
           case let .int(bytes)? = request.params["bytes"], bytes > 0,
           case let .string(sha)? = request.params["sha256"] {
            op.download = DownloadState(declared: UInt64(bytes), sha256: sha)
        }
        if policy.data == .binaryUpload {
            var limit = policy.maxItems
            if case let .int(maxCount)? = request.params["maxCount"] { limit = min(limit, Int(maxCount)) }
            op.upload = UploadState(maxChannels: limit)
        }

        // Lease starts at receipt, including while awaiting consent (§2.7).
        op.leaseExpiresAt = clock.monotonicNow + options.leaseExpiry
        armLease(op)

        // Deadline: min(timeoutMs, local maximum) from receipt (§2.1),
        // measured on the monotonic clock. The connection-owned control
        // stream is bounded by its registry maximum instead, so the local
        // clamp cannot tear down core.capabilities (which would close the
        // device connection).
        let localMax = request.lifetime == .connection
            ? Double(policy.maxTimeoutMs) / 1000
            : options.maxTimeout
        op.deadlineAt = clock.monotonicNow + min(Double(request.timeoutMs) / 1000, localMax)
        armDeadline(op)

        driver.start(op)
    }

    nonisolated static func validate(_ request: DeviceRequest, against policy: DeviceRevisionPolicy) -> String? {
        if request.version == 0 { return "version must be >= 1" }
        if !request.owner.matches(request.lifetime) { return "owner shape does not match lifetime" }
        if !policy.lifetimes.contains(request.lifetime) {
            return "lifetime '\(request.lifetime.rawValue)' not allowed"
        }
        if request.timeoutMs == 0 || request.timeoutMs > policy.maxTimeoutMs {
            return "timeoutMs out of bounds"
        }
        if request.initialCredit > policy.maxInitialCredit { return "initialCredit exceeds bound" }
        if policy.data == .binaryDownload && request.initialCredit != 0 {
            return "server-to-client data plane requires initialCredit 0"
        }
        return nil
    }

    private func armDeadline(_ op: DeviceOperation) {
        op.deadlineTimer?.cancel()
        let delay = max(0, op.deadlineAt - clock.monotonicNow)
        op.deadlineTimer = clock.schedule(after: delay) { [weak self, weak op] in
            guard let self = self, let op = op, op.phase != .terminal else { return }
            // Re-check the monotonic clock: a timer may fire early or late.
            if self.clock.monotonicNow >= op.deadlineAt {
                self.settle(op, reply: DeviceError(.timeout))
            } else {
                self.armDeadline(op)
            }
        }
    }

    // MARK: Events / controls

    private func handleEvent(_ value: DeviceJSON, id: UInt32) {
        // Unknown/stale ids are ignored whatever the message holds (D8):
        // renewals cannot create or revive (§2.7).
        guard let op = operations[id] else { return }
        let message: DeviceEvent
        do {
            message = try DeviceWire.decode(DeviceEvent.self, from: value)
        } catch {
            // Known-id invalid message: terminate that operation (§2.1).
            settle(op, reply: DeviceError(.invalidParams, "malformed deviceEvent"))
            return
        }
        guard let control = message.control else {
            // Capability events flow client → server only.
            settle(op, reply: DeviceError(.invalidParams, "capability event from the server"))
            return
        }
        switch control {
        case let .renewLease(seq):
            renew(op, seq: seq)
        case .cancel:
            // Server retired the id: stop work and respond `cancelled`
            // because this operation has not terminated (§2.1). The server
            // settled locally already and ignores the reply.
            settle(op, reply: DeviceError(.cancelled))
        case let .grant(amount):
            grant(op, amount: amount)
        case .leaseAck:
            settle(op, reply: DeviceError(.invalidParams, "leaseAck from the server"))
        case let .paused(flag):
            serverPaused(op, flag)
        }
    }

    private func renew(_ op: DeviceOperation, seq: UInt32) {
        let now = clock.monotonicNow
        // Check expiry before processing a queued renewal (§2.7).
        if now >= op.leaseExpiresAt {
            settle(op, reply: DeviceError(.connectionLost, "lease-expired"))
            return
        }
        // The first renewal is sequence 1; later ones strictly increase
        // (they may skip; they never repeat or decrease).
        if op.leaseSeq == 0, seq != 1 {
            settle(op, reply: DeviceError(.invalidParams, "first renewal is not sequence 1"))
            return
        }
        guard seq > op.leaseSeq else {
            settle(op, reply: DeviceError(.invalidParams, "renewal sequence not increasing"))
            return
        }
        op.leaseSeq = seq
        op.leaseExpiresAt = now + options.leaseExpiry
        armLease(op)
        send(DeviceEvent(id: op.request.id, control: .leaseAck(seq)), epoch: op.epoch)
    }

    private func armLease(_ op: DeviceOperation) {
        op.leaseTimer?.cancel()
        let delay = max(0, op.leaseExpiresAt - clock.monotonicNow)
        op.leaseTimer = clock.schedule(after: delay) { [weak self, weak op] in
            guard let self = self, let op = op, op.phase != .terminal else { return }
            if self.clock.monotonicNow >= op.leaseExpiresAt {
                self.settle(op, reply: DeviceError(.connectionLost, "lease-expired"))
            } else {
                self.armLease(op)
            }
        }
    }

    private func grant(_ op: DeviceOperation, amount: UInt32) {
        switch op.policy.data {
        case .none:
            // No data plane to credit: a known-id invalid message (§2.1).
            settle(op, reply: DeviceError(.invalidParams, "grant without a data plane"))
        case .binaryDownload:
            // The client is the data receiver here: a server grant is
            // wrong-direction (§2.3 "both endpoints reject wrong-direction
            // grants").
            settle(op, reply: DeviceError(.invalidParams, "grant from the data sender"))
        case .jsonEvents:
            // JSON stream credit counts events (§2.3): add it, reject
            // overflow past the revision bound, and flush held events.
            let sum = op.credit + UInt64(amount)
            if sum > op.policy.maxOutstandingCredit {
                settle(op, reply: DeviceError(.invalidParams, "credit overflow"))
                return
            }
            op.credit = sum
            flushEvents(op)
        case .binaryUpload:
            let sum = op.credit + UInt64(amount)
            if sum > op.policy.maxOutstandingCredit {
                settle(op, reply: DeviceError(.invalidParams, "credit overflow"))
                return
            }
            op.credit = sum
            if op.upload != nil { scheduleTurn() }
        }
    }

    /// `paused` is reported by the data sender: legal from the server only
    /// on a download, and only as a transition.
    private func serverPaused(_ op: DeviceOperation, _ flag: Bool) {
        guard op.policy.data == .binaryDownload, let download = op.download else {
            settle(op, reply: DeviceError(.invalidParams, "paused from the data receiver"))
            return
        }
        guard flag != download.serverPaused else {
            settle(op, reply: DeviceError(.invalidParams, "paused repeats the current state"))
            return
        }
        download.serverPaused = flag
    }

    // MARK: JSON stream events (§2.3)

    /// Held events per JSON stream while event credit is exhausted.
    /// `core.capabilities` coalesces to the one latest snapshot (§2.2); other
    /// `dropOldest` streams keep the newest `maxHeldEvents`.
    static let maxHeldEvents = 64

    func emitEvent(_ op: DeviceOperation, _ event: DeviceJSONObject) {
        guard isCurrent(op), op.phase == .running else { return }
        if event["kind"] == .string("progress") || event["kind"] == .string("blobStart") {
            // Host-owned events: `progress(_:)` and `openBlob`.
            settle(op, reply: DeviceError(.internal, "driver emitted a host-owned event"))
            return
        }
        if let violation = DevicePayloads.validate(op.request.capability, version: op.request.version,
                                                   kind: .event, value: .object(event)) {
            log.warn("driver produced an invalid event: \(violation)")
            settle(op, reply: DeviceError(.internal, "invalid event"))
            return
        }
        guard op.policy.data == .jsonEvents else {
            sendEvent(op, event)
            return
        }
        if op.credit > 0, op.pendingEvents.isEmpty {
            op.credit -= 1
            sendEvent(op, event)
            return
        }
        let cap = op.request.capability == CoreCapabilitiesDriver.name ? 1 : Self.maxHeldEvents
        op.pendingEvents.append(event)
        if op.pendingEvents.count > cap {
            op.pendingEvents.removeFirst(op.pendingEvents.count - cap) // dropOldest
        }
        flushEvents(op)
    }

    private func flushEvents(_ op: DeviceOperation) {
        while op.credit > 0, !op.pendingEvents.isEmpty, op.phase == .running {
            op.credit -= 1
            sendEvent(op, op.pendingEvents.removeFirst())
        }
    }

    private func sendEvent(_ op: DeviceOperation, _ event: DeviceJSONObject) {
        op.dataSeen = true
        send(DeviceEvent(id: op.request.id, event: event), epoch: op.epoch)
        // A snapshot the live core stream actually sent replaces the
        // advertisement: requests follow it from now on (§2.2).
        if op.request.id == coreStreamId, case let .array(offers)? = event["capabilities"] {
            applySnapshot(offers)
        }
    }

    private func applySnapshot(_ offers: [DeviceJSON]) {
        guard let accepted = selected else { return }
        var live: [String: UInt32] = [:]
        for selection in accepted.capabilities {
            let listed = offers.contains { offer in
                guard case let .string(name)? = offer["name"], DeviceWire.sameName(name, selection.name),
                      case let .array(versions)? = offer["versions"] else { return false }
                return versions.contains(.int(Int64(selection.version)))
            }
            if listed { live[selection.name] = selection.version }
        }
        liveSelection = live
    }

    func emitProgress(_ op: DeviceOperation, _ state: DeviceProgressState) {
        guard isCurrent(op), op.phase == .running else { return }
        if state == .pendingConsent, op.progressState == .running || op.dataSeen {
            log.debug("dropping progress that goes back to pendingConsent")
            return
        }
        op.progressState = state
        send(DeviceEvent(id: op.request.id, event: ["kind": .string("progress"), "state": .string(state.rawValue)]),
             epoch: op.epoch)
    }

    // MARK: Terminal paths

    private func isCurrent(_ op: DeviceOperation) -> Bool {
        op.epoch == epoch && operations[op.request.id] === op
    }

    func driverFinished(_ op: DeviceOperation, _ outcome: Outcome) {
        guard op.phase == .running, isCurrent(op) else { return }
        op.releasePrompt()
        switch outcome {
        case let .failure(error, simulated):
            op.cancelHandlers.removeAll()
            settle(op, reply: error, simulated: simulated)
        case let .success(result, blobs, simulated):
            switch op.policy.data {
            case .binaryUpload:
                // Cleanup registered before `succeed` stays armed for the
                // upload (it runs if the upload is cancelled).
                finishUploadProduction(op, result: result, blobs: blobs, simulated: simulated)
            case .binaryDownload:
                guard blobs.isEmpty, op.download?.verified == true else {
                    op.cancelHandlers.removeAll()
                    settle(op, reply: DeviceError(.internal, "download not verified"))
                    return
                }
                op.cancelHandlers.removeAll()
                completeWithResult(op, result, simulated: simulated)
            case .none, .jsonEvents:
                op.cancelHandlers.removeAll()
                guard blobs.isEmpty else {
                    settle(op, reply: DeviceError(.internal, "driver produced blobs for a non-upload capability"))
                    return
                }
                completeWithResult(op, result, simulated: simulated)
            }
        }
    }

    /// Validate a driver's result and send it as the terminal.
    private func completeWithResult(_ op: DeviceOperation, _ result: DeviceJSONObject, simulated: Bool) {
        if let violation = DevicePayloads.validate(op.request.capability, version: op.request.version,
                                                   kind: .result, value: .object(result)) {
            log.warn("driver produced an invalid result: \(violation)")
            settle(op, reply: DeviceError(.internal, "invalid result"))
            return
        }
        var response = DeviceResponse(id: op.request.id, result: result)
        response.simulated = simulated
        finishTerminal(op, response)
    }

    /// Settle a live operation: stop the driver/hardware, discard queued
    /// data, retire the id, and optionally send the terminal error.
    func settle(_ op: DeviceOperation, reply: DeviceError?, simulated: Bool = false) {
        guard op.phase != .terminal, operations[op.request.id] === op else { return }
        operations[op.request.id] = nil
        bulkOrder.removeAll { $0 == op.request.id }
        if coreStreamId == op.request.id { coreStreamId = nil }
        retire(op)
        if let error = reply {
            var response = DeviceResponse(id: op.request.id, error: error)
            response.simulated = simulated
            sendResponse(response, epoch: op.epoch)
        }
    }

    private func finishTerminal(_ op: DeviceOperation, _ response: DeviceResponse) {
        operations[op.request.id] = nil
        bulkOrder.removeAll { $0 == op.request.id }
        if coreStreamId == op.request.id { coreStreamId = nil }
        retire(op)
        sendResponse(response, epoch: op.epoch)
    }

    private func retire(_ op: DeviceOperation) {
        let wasLive = op.phase != .terminal
        op.phase = .terminal
        op.leaseTimer?.cancel()
        op.leaseTimer = nil
        op.deadlineTimer?.cancel()
        op.deadlineTimer = nil
        op.upload = nil
        op.download?.onChunk = nil
        op.download?.onComplete = nil
        op.pendingEvents.removeAll()
        op.suspendHandler = nil
        op.releasePrompt()
        let handlers = op.cancelHandlers
        op.cancelHandlers.removeAll()
        let ending = op.endHandlers
        op.endHandlers.removeAll()
        if wasLive { handlers.forEach { $0() } }
        ending.forEach { $0() }
    }

    // MARK: Upload (§2.3/§2.4, D2, D5)

    func openBlob(_ op: DeviceOperation, contentType: String, declaredBytes: UInt64?,
                  itemFields: DeviceJSONObject, data: Data?) -> DeviceBlobWriter? {
        guard isCurrent(op), op.phase == .running else { return nil }
        guard op.policy.data == .binaryUpload, let upload = op.upload else {
            settle(op, reply: DeviceError(.internal, "blob on a capability without an upload plane"))
            return nil
        }
        guard let channel = addChannel(op, upload, contentType: contentType, declared: declaredBytes,
                                       itemFields: itemFields) else { return nil }
        if let data = data { blobWrite(op, channel, data) }
        return DeviceBlobWriter(channel: channel.index, operation: op, item: channel)
    }

    private func addChannel(_ op: DeviceOperation, _ upload: UploadState, contentType: String,
                            declared: UInt64?, itemFields: DeviceJSONObject) -> UploadChannel? {
        guard upload.channels.count < upload.maxChannels, upload.channels.count <= Int(UInt16.max) else {
            settle(op, reply: DeviceError(.throttled, "too many items"))
            return nil
        }
        if let declared = declared, declared > op.policy.maxItemBytes {
            settle(op, reply: DeviceError(.throttled, "item exceeds size limit"))
            return nil
        }
        // Request-dependent metadata (§2.4): e.g. a camera item must fit the
        // requested mode. A driver bug surfaces as `internal`.
        if let violation = DevicePayloads.blobStartViolation(op.request.capability, params: op.request.params,
                                                             contentType: contentType) {
            log.warn("blob metadata does not fit the request: \(violation)")
            settle(op, reply: DeviceError(.internal, "blob type does not fit the request"))
            return nil
        }
        let channel = UploadChannel(index: UInt16(upload.channels.count), contentType: contentType,
                                    declared: declared, itemFields: itemFields)
        var start: DeviceJSONObject = [
            "kind": .string("blobStart"),
            "channel": .int(Int64(channel.index)),
            "contentType": .string(contentType),
        ]
        if let declared = declared { start["bytes"] = .int(Int64(declared)) }
        if let violation = DevicePayloads.validate(op.request.capability, version: op.request.version,
                                                   kind: .event, value: .object(start)) {
            log.warn("invalid blob announcement: \(violation)")
            settle(op, reply: DeviceError(.internal, "invalid blob announcement"))
            return nil
        }
        upload.channels.append(channel)
        op.dataSeen = true
        send(DeviceEvent(id: op.request.id, event: start), epoch: op.epoch)
        if !bulkOrder.contains(op.request.id) { bulkOrder.append(op.request.id) }
        return channel
    }

    func blobWrite(_ op: DeviceOperation, _ channel: UploadChannel, _ data: Data) {
        guard isCurrent(op), !channel.finished, !data.isEmpty else { return }
        let total = channel.written + UInt64(data.count)
        // Limits are enforced as bytes arrive, never from the declaration (D5).
        if total > op.policy.maxItemBytes {
            settle(op, reply: DeviceError(.throttled, "item exceeds size limit"))
            return
        }
        if let declared = channel.declared, total > declared {
            settle(op, reply: DeviceError(.internal, "item exceeds its declared size"))
            return
        }
        channel.written = total
        channel.chunks.append(data)
        channel.buffered += data.count
        scheduleTurn()
    }

    func blobFinish(_ op: DeviceOperation, _ channel: UploadChannel) {
        guard isCurrent(op), !channel.finished else { return }
        if let declared = channel.declared, channel.written != declared {
            settle(op, reply: DeviceError(.internal, "item ended before its declared size"))
            return
        }
        channel.finished = true
        scheduleTurn()
    }

    private func finishUploadProduction(_ op: DeviceOperation, result: DeviceJSONObject,
                                        blobs: [DeviceBlob], simulated: Bool) {
        guard let upload = op.upload else {
            settle(op, reply: DeviceError(.internal, "no upload state"))
            return
        }
        for blob in blobs {
            if UInt64(blob.bytes.count) > op.policy.maxItemBytes {
                settle(op, reply: DeviceError(.throttled, "item exceeds size limit"))
                return
            }
        }
        guard upload.channels.count + blobs.count <= upload.maxChannels else {
            settle(op, reply: DeviceError(.throttled, "too many items"))
            return
        }
        for blob in blobs {
            guard let channel = addChannel(op, upload, contentType: blob.contentType,
                                           declared: blob.declaresSize ? UInt64(blob.bytes.count) : nil,
                                           itemFields: blob.itemFields) else { return }
            if !blob.bytes.isEmpty {
                channel.written = UInt64(blob.bytes.count)
                channel.chunks.append(blob.bytes)
                channel.buffered = blob.bytes.count
            }
        }
        // The driver is done producing: open items end here.
        for channel in upload.channels where !channel.finished {
            if let declared = channel.declared, channel.written != declared {
                settle(op, reply: DeviceError(.internal, "item ended before its declared size"))
                return
            }
            channel.finished = true
        }
        upload.result = result
        upload.simulated = simulated
        op.phase = .uploading
        if !bulkOrder.contains(op.request.id) { bulkOrder.append(op.request.id) }
        scheduleTurn()
    }

    private func scheduleTurn() {
        guard !turnScheduled else { return }
        turnScheduled = true
        let turnEpoch = epoch
        clock.enqueueTurn { [weak self] in
            guard let self = self else { return }
            self.turnScheduled = false
            guard self.epoch == turnEpoch else {
                if self.hasReadyWork() { self.scheduleTurn() }
                return
            }
            self.runTurn()
        }
    }

    /// The next step for an operation with upload state, without side effects.
    private func nextStep(_ op: DeviceOperation) -> UploadStep? {
        guard op.phase != .terminal, let upload = op.upload else { return nil }
        var waitingForCredit = false
        for channel in upload.channels where !channel.completed {
            if channel.buffered > 0 {
                if op.credit == 0 {
                    waitingForCredit = true
                    continue
                }
                let n = min(DeviceProtocolConstants.maxBulkChunkBytes, channel.buffered)
                return .frame(channel, Int(min(UInt64(n), op.credit)))
            }
            // A finished item with nothing buffered ends now; a zero-byte
            // item sends no frame at all (D2).
            if channel.finished { return .finishItem(channel) }
        }
        if waitingForCredit { return .awaitingCredit }
        if upload.result != nil, upload.channels.allSatisfy({ $0.completed }) { return .terminal }
        return nil
    }

    /// One scheduling turn: flush ready JSON (item ends, terminals), hand at
    /// most one ≤64 KiB chunk to the transport, and stop bulk while
    /// transport-pending bytes are at the 256 KiB bound. Each frame is cut
    /// from the item's buffered bytes and sized to `min(64 KiB, remaining
    /// credit)`; with zero credit the operation reports `paused:true` once
    /// and waits for a grant. Operations share bulk capacity round-robin;
    /// per-operation order is preserved.
    private func runTurn() {
        guard let transport = transport else { return }
        var handedFrame = false
        var visits = bulkOrder.count
        while visits > 0, !bulkOrder.isEmpty {
            visits -= 1
            let id = bulkOrder.removeFirst()
            guard let op = operations[id], op.phase != .terminal, let upload = op.upload else { continue }
            var done = false
            drain: while let step = nextStep(op) {
                switch step {
                case let .finishItem(channel):
                    var item: DeviceJSONObject = channel.itemFields
                    item["channel"] = .int(Int64(channel.index))
                    item["contentType"] = .string(channel.contentType)
                    item["bytes"] = .int(Int64(channel.sent))
                    item["sha256"] = .string(channel.hasher.finalize())
                    channel.item = item
                    channel.completed = true
                    channel.chunks = []
                case .terminal:
                    guard let result = upload.result else { break drain }
                    var terminal = result
                    let items = upload.channels.sorted { $0.index < $1.index }.compactMap { $0.item }
                    if DeviceRegistry.resultItemField(op.request.capability) == "item" {
                        guard items.count == 1 else {
                            settle(op, reply: DeviceError(.internal, "exactly one item expected"))
                            done = true
                            break drain
                        }
                        terminal["item"] = .object(items[0])
                    } else {
                        terminal["items"] = .array(items.map { .object($0) })
                    }
                    if let violation = DevicePayloads.validate(op.request.capability, version: op.request.version,
                                                               kind: .result, value: .object(terminal)) {
                        log.warn("upload result invalid: \(violation)")
                        settle(op, reply: DeviceError(.internal, "invalid result"))
                        done = true
                        break drain
                    }
                    var response = DeviceResponse(id: id, result: terminal)
                    response.simulated = upload.simulated
                    // Completed, not cancelled: cleanup handlers are discarded.
                    op.cancelHandlers.removeAll()
                    finishTerminal(op, response)
                    done = true
                    break drain
                case .awaitingCredit:
                    if !op.paused {
                        op.paused = true
                        send(DeviceEvent(id: id, control: .paused(true)), epoch: op.epoch)
                    }
                    break drain
                case let .frame(channel, n):
                    if handedFrame || pendingTransportBytes >= DeviceProtocolConstants.maxTransportPendingBytes {
                        break drain
                    }
                    // A sender terminates before `seq` would wrap (§2.3).
                    guard channel.nextSeq <= UInt64(UInt32.max) else {
                        settle(op, reply: DeviceError(.internal, "upload seq exhausted"))
                        done = true
                        break drain
                    }
                    if op.paused {
                        op.paused = false
                        send(DeviceEvent(id: id, control: .paused(false)), epoch: op.epoch)
                    }
                    let payload = channel.take(n)
                    let frame = DeviceFrameCodec.encode(
                        DeviceFrameHeader(channel: channel.index, requestId: id, seq: UInt32(channel.nextSeq)),
                        payload: payload)
                    channel.hasher.update(payload)
                    channel.sent += UInt64(n)
                    channel.nextSeq += 1
                    op.credit -= UInt64(n)
                    op.dataSeen = true
                    pendingTransportBytes += frame.count
                    handedFrame = true
                    let sentEpoch = epoch
                    let size = frame.count
                    transport.sendDeviceBinary(frame) { [weak self] in
                        self?.frameSent(size: size, epoch: sentEpoch)
                    }
                }
            }
            if !done, op.phase != .terminal, operations[id] === op {
                bulkOrder.append(id)
            }
        }
        if hasReadyWork() { scheduleTurn() }
    }

    private func frameSent(size: Int, epoch sentEpoch: UInt64) {
        guard sentEpoch == epoch else { return }
        pendingTransportBytes = max(0, pendingTransportBytes - size)
        if hasReadyWork() { scheduleTurn() }
    }

    private func hasReadyWork() -> Bool {
        for id in bulkOrder {
            guard let op = operations[id], let step = nextStep(op) else { continue }
            switch step {
            case .finishItem, .terminal:
                return true
            case .awaitingCredit:
                // Report the pause transition on the next turn; then wait
                // for a grant (which schedules a turn itself).
                if !op.paused { return true }
            case .frame:
                if pendingTransportBytes < DeviceProtocolConstants.maxTransportPendingBytes { return true }
            }
        }
        return false
    }

    // MARK: Download (§2.3/§2.4, file.save)

    func grantDownload(_ op: DeviceOperation, _ bytes: UInt64) -> UInt64 {
        guard isCurrent(op), op.phase == .running, let download = op.download, !download.verified else { return 0 }
        // Credit is an upper bound: granting past the remaining bytes is
        // legal; only the revision's outstanding bound limits it.
        let room = op.policy.maxOutstandingCredit - min(op.policy.maxOutstandingCredit, download.credit)
        let amount = min(bytes, room, UInt64(UInt32.max))
        guard amount > 0 else { return 0 }
        download.credit += amount
        download.granted += amount
        send(DeviceEvent(id: op.request.id, control: .grant(UInt32(amount))), epoch: op.epoch)
        return amount
    }

    private func receiveDownloadFrame(_ op: DeviceOperation, _ frame: DecodedDeviceFrame) {
        guard let download = op.download, !download.verified else {
            settle(op, reply: DeviceError(.invalidParams, "bytes after the download completed"))
            return
        }
        let payload = frame.payload
        let violation: String?
        if payload.isEmpty {
            violation = "zero-length frame"
        } else if payload.count > DeviceProtocolConstants.maxBulkChunkBytes {
            violation = "chunk above 64 KiB"
        } else if frame.header.channel != 0 {
            violation = "bytes on an unannounced channel"
        } else if download.serverPaused {
            violation = "data while the sender reported paused"
        } else if !download.sequence.accept(frame.header.seq, overflow: op.policy.overflow) {
            violation = "seq \(frame.header.seq) rejected"
        } else if UInt64(payload.count) > download.credit {
            violation = "data beyond granted credit"
        } else if download.received + UInt64(payload.count) > download.declared {
            violation = "bytes beyond the declaration"
        } else {
            violation = nil
        }
        if let violation = violation {
            settle(op, reply: DeviceError(.invalidParams, violation))
            return
        }
        download.credit -= UInt64(payload.count)
        download.received += UInt64(payload.count)
        download.hasher.update(payload)
        op.dataSeen = true
        download.onChunk?(payload)
        guard isCurrent(op), download.received == download.declared else { return }
        guard download.hasher.finalize() == download.sha256 else {
            settle(op, reply: DeviceError(.invalidParams, "received bytes do not match the declared sha256"))
            return
        }
        download.verified = true
        let complete = download.onComplete
        download.onComplete = nil
        complete?()
    }

    // MARK: Sending

    func send(_ event: DeviceEvent, epoch sendEpoch: UInt64) {
        guard sendEpoch == epoch, let transport = transport else { return }
        guard let data = try? DeviceWire.encode(event) else { return }
        transport.sendDeviceMessage(data)
    }

    private func sendResponse(_ response: DeviceResponse, epoch sendEpoch: UInt64? = nil) {
        guard sendEpoch == nil || sendEpoch == epoch, let transport = transport else { return }
        guard let data = try? DeviceWire.encode(response) else { return }
        transport.sendDeviceMessage(data)
    }
}

// MARK: - core.capabilities (mandatory, connection-owned)

/// `core.capabilities@1`: emits one full advertisement, then stays open
/// until the server cancels/reopens it or the socket closes (§2.2).
@MainActor
final class CoreCapabilitiesDriver: DeviceDriver {
    static let name = "core.capabilities"
    let capability = CoreCapabilitiesDriver.name

    static func snapshot(_ offers: [CapabilityOffer]) -> DeviceJSONObject {
        ["capabilities": .array(offers.map {
            .object(["name": .string($0.name), "versions": .array($0.versions.map { .int(Int64($0)) })])
        })]
    }

    static func snapshot(_ hello: DeviceHello) -> DeviceJSONObject {
        snapshot(hello.capabilities)
    }

    func start(_ operation: DeviceOperation) {
        guard operation.request.params.isEmpty else {
            operation.fail(.invalidParams, "core.capabilities params must be {}")
            return
        }
        guard let host = operation.host else { return }
        operation.emit(Self.snapshot(host.snapshotOffers()))
    }
}

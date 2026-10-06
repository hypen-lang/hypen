import Foundation
@preconcurrency import HypenEngine

// Device Capability Protocol (RFC 001 §4/§7) — handler-facing device access.
//
// `DeviceContext` is what `ctx.device` is inside a handler. It is scoped per
// invocation/activation, so it carries the owner authority (module instance
// + activation) the broker needs, and it enforces the replay firewall
// (§1.7): a device call issued from a replayed or broadcast-derived
// dispatch fails with `unavailable`, and that restriction survives `await`
// (the provenance is fixed when the context is built).
//
// Everything protocol-side — admission against the live selection and the
// selected revision (lifetimes, pin caps, deadline and credit clamps,
// params and download announcements), leases, credit, blob verification,
// result and event validation — is the Rust broker's, reached through the
// connection's `DevicePlane`. Params go to the broker as JSON (`JSONEncoder`
// over the typed params); results and events come back as JSON the broker
// already validated, decoded here with `JSONDecoder`. This file is the
// typed, `Result`-style Swift API on top of it:
//
//     let status = await ctx.device.permissions.query(.camera)
//     switch status {
//     case .success(let v): v.status          // PermissionStatus
//     case .failure(let e): e.code            // .denied, .unsupported, …
//     }
//
//     let scan = ctx.device.bluetooth.scan()
//     for await device in scan { … }           // credit paced by the loop
//     let end = await scan.result()
//
// Swift `Task` cancellation cancels the device request (the client is told
// `cancel`) and settles it `cancelled`.

// MARK: - Results

extension DeviceError: Error {}

extension DeviceError {
    public static let cancelled = DeviceError(code: .cancelled)
    public static let connectionLost = DeviceError(code: .connectionLost)
    public static let unsupported = DeviceError(code: .unsupported)
}

/// A successful device value plus the protocol's `simulated` marker (set when
/// a development fake host produced it, RFC 001 §1.11). Members of the value
/// are reachable directly: `try result.get().status`.
@dynamicMemberLookup
public struct DeviceValue<T: Sendable>: Sendable {
    public let value: T
    /// True when a simulated host (e.g. `FakeDeviceHost`) produced the result.
    public let simulated: Bool

    public init(_ value: T, simulated: Bool = false) {
        self.value = value
        self.simulated = simulated
    }

    public subscript<U>(dynamicMember keyPath: KeyPath<T, U>) -> U {
        value[keyPath: keyPath]
    }
}

/// Every device call ends in a value: the client's result, or an error
/// value (`denied`, `cancelled`, `revoked`, `timeout`, …). Never a throw.
public typealias DeviceResult<T: Sendable> = Result<DeviceValue<T>, DeviceError>

/// Where the dispatch a device call is made from came from (RFC 001 §1.7).
public enum DeviceProvenance: Sendable, Hashable {
    /// A dispatch the connection's own client originated.
    case origin
    /// A replayed or broadcast-derived dispatch: it cannot acquire device
    /// authority.
    case replay
}

/// Task-local replay marker. Dispatches run inside
/// `DeviceProvenance.$current.withValue(.replay) { … }` build handler contexts
/// with replay provenance — including contexts built by `Task`s spawned from
/// them, which inherit the value.
extension DeviceProvenance {
    @TaskLocal public static var current: DeviceProvenance = .origin
}

// MARK: - Options

/// Per-request options (RFC 001 §2.4/§2.7).
public struct DeviceRequestOptions: Sendable {
    /// Request lifetime. Defaults to the revision's first lifetime
    /// (`activation`). `background` is allowed only when the selected revision
    /// lists it: the module instance owns the work (it survives deactivation
    /// and is swept on destruction) and counts toward the per-connection pin
    /// cap. `connection` is protocol-internal.
    public var lifetime: DeviceLifetime?
    /// Overall deadline; clamped to the revision's `maxTimeoutMs`.
    public var timeoutMs: UInt64?
    /// Initial client → server data credit (bytes for uploads, events for
    /// JSON streams); clamped to the revision's `maxInitialCredit`. `0` on a
    /// client → server data plane is refused `invalidParams` (the client
    /// could never send anything).
    public var initialCredit: UInt64?

    public init(lifetime: DeviceLifetime? = nil, timeoutMs: UInt64? = nil, initialCredit: UInt64? = nil) {
        self.lifetime = lifetime
        self.timeoutMs = timeoutMs
        self.initialCredit = initialCredit
    }
}

// MARK: - Typed capabilities

/// A unary capability request typed by its params and result
/// (`permission.query`, `gallery.pick`, `camera.capture`, …).
public protocol DeviceUnaryCapability: Sendable {
    associatedtype Params: Encodable & Sendable
    associatedtype Output: Sendable
    /// Wire capability name.
    static var name: String { get }
    var params: Params { get }
    /// The handler-facing value of a result the broker verified
    /// (`resultJSON` is its validated JSON, `blobs` the verified items).
    static func output(resultJSON: String, blobs: [DeviceReceivedBlob]) throws -> Output
}

/// A JSON event stream capability (`bluetooth.scan`).
public protocol DeviceEventStreamCapability: Sendable {
    associatedtype Params: Encodable & Sendable
    associatedtype Event: Sendable
    associatedtype Output: Sendable
    static var name: String { get }
    var params: Params { get }
    /// The handler-facing value of one event the broker validated against
    /// the revision's event schema; nil skips it (e.g. `progress`).
    static func event(eventJSON: String) -> Event?
    static func output(resultJSON: String) throws -> Output
}

/// A binary-upload stream capability (`mic.record`): bytes are delivered in
/// order as they arrive, never buffered whole server-side.
public protocol DeviceDataStreamCapability: Sendable {
    associatedtype Params: Encodable & Sendable
    associatedtype Output: Sendable
    static var name: String { get }
    var params: Params { get }
    static func output(resultJSON: String) throws -> Output
}

/// Verified upload items of `gallery.pick` / `file.pick`.
public struct DevicePickedItems: Sendable, Hashable {
    public let items: [DeviceReceivedBlob]
}

/// `permission.query@1`: the current status, never prompts.
public struct PermissionQuery: DeviceUnaryCapability {
    public static let name = "permission.query"
    public let params: PermissionParams
    public init(_ permission: Permission) { params = PermissionParams(permission: permission) }
    public static func output(resultJSON: String, blobs: [DeviceReceivedBlob]) throws -> PermissionResult {
        try DeviceBrokerJSON.decode(PermissionResult.self, from: resultJSON)
    }
}

/// `permission.request@1`: prompts through the platform flow when needed.
public struct PermissionRequest: DeviceUnaryCapability {
    public static let name = "permission.request"
    public let params: PermissionParams
    public init(_ permission: Permission) { params = PermissionParams(permission: permission) }
    public static func output(resultJSON: String, blobs: [DeviceReceivedBlob]) throws -> PermissionResult {
        try DeviceBrokerJSON.decode(PermissionResult.self, from: resultJSON)
    }
}

/// `gallery.pick@1`: photos/videos the user picked, bytes verified.
public struct GalleryPick: DeviceUnaryCapability {
    public static let name = "gallery.pick"
    public let params: GalleryPickParams
    public init(mediaTypes: [MediaType] = [.photo], maxCount: UInt16 = 1) {
        params = GalleryPickParams(mediaTypes: mediaTypes, maxCount: maxCount)
    }
    public static func output(resultJSON: String, blobs: [DeviceReceivedBlob]) throws -> DevicePickedItems {
        DevicePickedItems(items: blobs)
    }
}

/// `file.pick@1`: files the user picked, bytes verified.
public struct FilePick: DeviceUnaryCapability {
    public static let name = "file.pick"
    public let params: FilePickParams
    public init(accept: [String] = [], maxCount: UInt16 = 1) {
        params = FilePickParams(accept: accept, maxCount: maxCount)
    }
    public static func output(resultJSON: String, blobs: [DeviceReceivedBlob]) throws -> DevicePickedItems {
        DevicePickedItems(items: blobs)
    }
}

/// `camera.capture@1`: exactly one photo or video, bytes verified.
public struct CameraCapture: DeviceUnaryCapability {
    public static let name = "camera.capture"
    public let params: CameraCaptureParams
    public init(_ params: CameraCaptureParams) { self.params = params }
    public init(mode: CaptureMode, facing: CameraFacing? = nil, maxDurationMs: UInt64? = nil) {
        params = CameraCaptureParams(mode: mode, facing: facing, maxDurationMs: maxDurationMs)
    }
    public static func output(resultJSON: String, blobs: [DeviceReceivedBlob]) throws -> DeviceReceivedBlob {
        // The broker admits exactly one verified item (maxItems 1).
        guard blobs.count == 1, let item = blobs.first else {
            throw DeviceError(code: .invalidParams, platformDetail: "camera.capture result must hold exactly one item")
        }
        return item
    }
}

/// `bluetooth.select@1`: the identity of the device the user chose.
public struct BluetoothSelect: DeviceUnaryCapability {
    public static let name = "bluetooth.select"
    public let params: BluetoothSelectParams
    public init(services: [String]? = nil, namePrefix: String? = nil) {
        params = BluetoothSelectParams(services: services, namePrefix: namePrefix)
    }
    public static func output(resultJSON: String, blobs: [DeviceReceivedBlob]) throws -> SelectedBluetoothDevice {
        try DeviceBrokerJSON.decode(BluetoothSelectResult.self, from: resultJSON).device
    }
}

/// `bluetooth.scan@1`: advertisements as they are seen.
public struct BluetoothScan: DeviceEventStreamCapability {
    public static let name = "bluetooth.scan"
    public let params = BluetoothScanParams()
    public init() {}
    public static func event(eventJSON: String) -> BluetoothDevice? {
        // Device events carry `device`; `progress` events do not.
        (try? DeviceBrokerJSON.decode(BluetoothScanEvent.self, from: eventJSON))?.device
    }
    public static func output(resultJSON: String) throws -> BluetoothScanResult {
        try DeviceBrokerJSON.decode(BluetoothScanResult.self, from: resultJSON)
    }
}

/// `mic.record@1`: PCM16 little-endian audio, interleaved when stereo.
public struct MicRecord: DeviceDataStreamCapability {
    public static let name = "mic.record"
    public let params: MicRecordParams
    public init(sampleRate: UInt32, channels: UInt8? = nil, maxDurationMs: UInt64? = nil) {
        params = MicRecordParams(sampleRate: sampleRate, format: .pcm16, maxDurationMs: maxDurationMs, channels: channels)
    }
    public static func output(resultJSON: String) throws -> MicRecordResult {
        try DeviceBrokerJSON.decode(MicRecordResult.self, from: resultJSON)
    }
}

/// An untyped result (for names only known at runtime): the client's result
/// as the JSON text the broker validated, and the verified upload items.
public struct DeviceUntypedResult: Sendable {
    /// The validated result object, as JSON text.
    public let resultJSON: String
    public let blobs: [DeviceReceivedBlob]

    /// Decode the result into a `Decodable` type.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try DeviceBrokerJSON.decode(type, from: resultJSON)
    }

    /// The result as a Foundation JSON object.
    public var object: [String: Any] {
        ((try? JSONSerialization.jsonObject(with: Data(resultJSON.utf8))) as? [String: Any]) ?? [:]
    }
}

// MARK: - Streams

/// A buffer between the plane's pump and one `for await` consumer. Credit is
/// returned to the broker as the consumer ADVANCES (asks for the next
/// element), so a slow loop body backpressures the device.
final class DeviceStreamBuffer<Element: Sendable>: DevicePlaneConsumer, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []
    private var head = 0
    private var finished = false
    private var waiter: CheckedContinuation<Element?, Never>?
    private var unacknowledged = 0
    private var iterated = false
    private let isData: Bool
    private let convertEvent: @Sendable (String) -> Element?
    private let convertData: @Sendable (UInt16, Data) -> Element?
    /// Set right after the plane opened the request.
    var id: UInt32 = 0
    weak var plane: DevicePlane?

    init(
        isData: Bool,
        event: @escaping @Sendable (String) -> Element? = { _ in nil },
        data: @escaping @Sendable (UInt16, Data) -> Element? = { _, _ in nil }
    ) {
        self.isData = isData
        self.convertEvent = event
        self.convertData = data
    }

    /// A buffer that never receives anything (a refused request).
    static func finishedBuffer() -> DeviceStreamBuffer<Element> {
        let b = DeviceStreamBuffer(isData: false)
        b.finished = true
        return b
    }

    // Called by the plane's pump (under its lock).
    func deliverEvent(_ json: String) {
        guard let e = convertEvent(json) else {
            // Not a consumer-facing event (e.g. progress): consumed at once.
            plane?.consumedEvents(id, 1)
            return
        }
        enqueue(e)
    }

    func deliverData(channel: UInt16, bytes: Data) {
        guard let e = convertData(channel, bytes) else {
            plane?.consumedData(id, 1)
            return
        }
        enqueue(e)
    }

    private func enqueue(_ e: Element) {
        lock.lock()
        if finished { lock.unlock(); return }
        if let w = waiter {
            waiter = nil
            unacknowledged += 1
            lock.unlock()
            w.resume(returning: e)
            return
        }
        items.append(e)
        lock.unlock()
    }

    func finish(dropBuffered: Bool) {
        lock.lock()
        finished = true
        if dropBuffered {
            items.removeAll()
            head = 0
        }
        let w = head >= items.count ? waiter : nil
        if w != nil { waiter = nil }
        lock.unlock()
        w?.resume(returning: nil)
    }

    var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return finished }

    /// Claim the single iterator. A second iterator sees an empty sequence.
    func claimIterator() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if iterated { return false }
        iterated = true
        return true
    }

    /// The consumer is done with everything handed out so far.
    private func acknowledge() {
        lock.lock()
        let n = unacknowledged
        unacknowledged = 0
        let done = finished
        lock.unlock()
        guard n > 0, !done, let plane else { return }
        if isData {
            plane.consumedData(id, UInt32(n))
        } else {
            plane.consumedEvents(id, UInt64(n))
        }
    }

    func next(onCancel: @escaping @Sendable () -> Void) async -> Element? {
        acknowledge()
        if Task.isCancelled {
            onCancel()
            return nil
        }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (c: CheckedContinuation<Element?, Never>) in
                lock.lock()
                if head < items.count {
                    let e = items[head]
                    head += 1
                    if head > 64, head * 2 > items.count {
                        items.removeFirst(head)
                        head = 0
                    }
                    unacknowledged += 1
                    lock.unlock()
                    c.resume(returning: e)
                    return
                }
                if finished {
                    lock.unlock()
                    c.resume(returning: nil)
                    return
                }
                waiter = c
                lock.unlock()
            }
        } onCancel: {
            onCancel()
            lock.lock()
            let w = waiter
            waiter = nil
            lock.unlock()
            w?.resume(returning: nil)
        }
    }
}

/// Cancels a stream whose iterator was dropped before it ended (a `break`
/// out of the `for await` loop abandons the stream).
final class DeviceIteratorToken: @unchecked Sendable {
    private let onAbandon: @Sendable () -> Void
    private let isFinished: @Sendable () -> Bool
    init(isFinished: @escaping @Sendable () -> Bool, onAbandon: @escaping @Sendable () -> Void) {
        self.isFinished = isFinished
        self.onAbandon = onAbandon
    }
    deinit {
        if !isFinished() { onAbandon() }
    }
}

/// Shared machinery of the two stream handle types.
final class DeviceStreamCore<Element: Sendable>: @unchecked Sendable {
    let id: UInt32?
    let buffer: DeviceStreamBuffer<Element>
    private let settlement: DeviceSettlementBox
    private let cancelRequest: @Sendable () -> Void

    init(id: UInt32?, buffer: DeviceStreamBuffer<Element>, settlement: DeviceSettlementBox,
         cancel: @escaping @Sendable () -> Void) {
        self.id = id
        self.buffer = buffer
        self.settlement = settlement
        self.cancelRequest = cancel
    }

    func cancel() { cancelRequest() }

    func settled() async -> DevicePlaneSettlement {
        let cancel = cancelRequest
        return await withTaskCancellationHandler {
            await settlement.wait()
        } onCancel: {
            cancel()
        }
    }

    func iterator() -> (DeviceStreamBuffer<Element>?, DeviceIteratorToken?) {
        guard buffer.claimIterator() else { return (nil, nil) }
        let b = buffer
        let cancel = cancelRequest
        return (b, DeviceIteratorToken(isFinished: { b.isFinished }, onAbandon: cancel))
    }
}

/// A live JSON event stream (`bluetooth.scan`). Iterate it for events (one
/// consumer; credit returns as the loop advances), await `result()` for the
/// terminal outcome, `cancel()` to abandon it.
public final class DeviceEventStream<Event: Sendable, Output: Sendable>: AsyncSequence, @unchecked Sendable {
    public typealias Element = Event
    let core: DeviceStreamCore<Event>
    private let makeOutput: @Sendable (String) throws -> Output

    init(core: DeviceStreamCore<Event>, output: @escaping @Sendable (String) throws -> Output) {
        self.core = core
        self.makeOutput = output
    }

    /// Wire request id, or nil when the stream was refused locally.
    public var id: UInt32? { core.id }

    /// Abandon the stream (server-side cancellation; idempotent).
    public func cancel() { core.cancel() }

    /// The terminal outcome, exactly once. Cancelling the awaiting task
    /// cancels the stream.
    public func result() async -> DeviceResult<Output> {
        switch await core.settled() {
        case .failure(let e): return .failure(e)
        case .success(let resultJSON, _, let simulated, let release):
            release?()
            do { return .success(DeviceValue(try makeOutput(resultJSON), simulated: simulated)) }
            catch { return .failure(DeviceContext.outputError(error)) }
        }
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        let buffer: DeviceStreamBuffer<Event>?
        let token: DeviceIteratorToken?
        let cancel: @Sendable () -> Void
        public mutating func next() async -> Event? {
            guard let buffer else { return nil }
            _ = token
            return await buffer.next(onCancel: cancel)
        }
    }

    public func makeAsyncIterator() -> AsyncIterator {
        let (buffer, token) = core.iterator()
        let c = core
        return AsyncIterator(buffer: buffer, token: token, cancel: { c.cancel() })
    }
}

/// One chunk of a binary-upload stream, in arrival order.
public struct DeviceDataChunk: Sendable, Hashable {
    public let channel: UInt16
    public let bytes: Data
}

/// A live binary-upload stream (`mic.record`). Iterate it for the bytes in
/// order (credit returns as the loop advances, so a slow consumer
/// backpressures the device); `result()` resolves after the last chunk was
/// consumed, with the result whose sha256 the broker verified over every
/// byte delivered. The stream only completes while it is being consumed.
public final class DeviceDataStream<Output: Sendable>: AsyncSequence, @unchecked Sendable {
    public typealias Element = DeviceDataChunk
    let core: DeviceStreamCore<DeviceDataChunk>
    private let makeOutput: @Sendable (String) throws -> Output

    init(core: DeviceStreamCore<DeviceDataChunk>, output: @escaping @Sendable (String) throws -> Output) {
        self.core = core
        self.makeOutput = output
    }

    public var id: UInt32? { core.id }
    public func cancel() { core.cancel() }

    public func result() async -> DeviceResult<Output> {
        switch await core.settled() {
        case .failure(let e): return .failure(e)
        case .success(let resultJSON, _, let simulated, let release):
            release?()
            do { return .success(DeviceValue(try makeOutput(resultJSON), simulated: simulated)) }
            catch { return .failure(DeviceContext.outputError(error)) }
        }
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        let buffer: DeviceStreamBuffer<DeviceDataChunk>?
        let token: DeviceIteratorToken?
        let cancel: @Sendable () -> Void
        public mutating func next() async -> DeviceDataChunk? {
            guard let buffer else { return nil }
            _ = token
            return await buffer.next(onCancel: cancel)
        }
    }

    public func makeAsyncIterator() -> AsyncIterator {
        let (buffer, token) = core.iterator()
        let c = core
        return AsyncIterator(buffer: buffer, token: token, cancel: { c.cancel() })
    }
}

// MARK: - DeviceContext

/// The owner authority captured by a handler context (RFC 001 §2.7).
public struct DeviceOwnerAuthority: Sendable, Hashable {
    public let moduleInstanceId: String
    public let activationId: UInt32
}

/// The per-invocation device surface of a handler (`ctx.device`). Owner and
/// provenance are fixed at construction; a handler cannot forge another
/// owner's authority or launder a replayed dispatch into a live request.
public final class DeviceContext: @unchecked Sendable {
    private let plane: DevicePlane?
    /// The owner authority, nil for a context without an owner.
    public let owner: DeviceOwnerAuthority?
    public let provenance: DeviceProvenance
    private let blockedDetail: String?
    private let ownerLive: @Sendable () -> Bool

    private let lock = NSLock()
    private var scopeOpen = false
    private var scopeCancels: [UInt32: @Sendable () -> Void] = [:]
    private var scopeReleases: [@Sendable () -> Void] = []

    init(
        plane: DevicePlane?,
        owner: DeviceOwnerAuthority?,
        provenance: DeviceProvenance,
        blockedDetail: String? = nil,
        ownerLive: @escaping @Sendable () -> Bool = { true }
    ) {
        self.plane = plane
        self.owner = owner
        self.provenance = provenance
        self.blockedDetail = blockedDetail
        self.ownerLive = ownerLive
    }

    /// A context that refuses everything with `unavailable` (no device plane
    /// on this connection, or a handler outside any module).
    public static func unavailable(_ detail: String = "device-disabled") -> DeviceContext {
        DeviceContext(plane: nil, owner: nil, provenance: .origin, blockedDetail: detail)
    }

    // MARK: Handler scope (RFC 001 §2.4)

    /// Open the invoking handler's scope: unary requests opened while it is
    /// open are cancelled if still pending when the handler returns, and
    /// delivered results keep counting toward the connection's retained-bytes
    /// quota until it ends. Called by the module instance around an async
    /// handler; not for application code.
    func beginHandlerScope() {
        lock.lock(); defer { lock.unlock() }
        scopeOpen = true
    }

    /// The invoking handler returned: cancel the unary requests it left
    /// pending and release the charge of results it received. Requests
    /// issued later through this context are not scoped. Streams are never
    /// scoped; they end with their owner.
    func endHandlerScope() {
        lock.lock()
        guard scopeOpen else { lock.unlock(); return }
        scopeOpen = false
        let cancels = Array(scopeCancels.values)
        scopeCancels.removeAll()
        let releases = scopeReleases
        scopeReleases.removeAll()
        lock.unlock()
        for c in cancels { c() }
        for r in releases { r() }
    }

    // MARK: Queries

    /// Negotiated live support — not a permission grant (RFC 001 §4).
    public func supports(_ capability: String) -> Bool {
        plane?.supports(capability) ?? false
    }

    /// Typed form of `supports(_:)`.
    public func supports<C: DeviceUnaryCapability>(_ type: C.Type) -> Bool { supports(C.name) }

    private func guardError() -> DeviceError? {
        if provenance == .replay {
            return DeviceError(code: .unavailable, platformDetail: "replay")
        }
        guard let plane else {
            return DeviceError(code: .unavailable, platformDetail: blockedDetail ?? "device-disabled")
        }
        if plane.isClosed { return .connectionLost }
        if blockedDetail != nil || owner == nil {
            return DeviceError(code: .unavailable, platformDetail: blockedDetail ?? "owner-inactive")
        }
        if !ownerLive() {
            return DeviceError(code: .unavailable, platformDetail: "owner-inactive")
        }
        return nil
    }

    /// `initialCredit` for the wire: absent, or ≥ 1 on a client → server data
    /// plane; ignored for data planes without client → server data.
    private func wireCredit(_ capability: String, _ data: DeviceDataPlane?, _ options: DeviceRequestOptions)
        -> Result<UInt64?, DeviceError>
    {
        guard let credit = options.initialCredit else { return .success(nil) }
        guard data == .binaryUpload || data == .jsonEvents else { return .success(nil) }
        if credit < 1 {
            return .failure(DeviceError(
                code: .invalidParams,
                platformDetail: "initialCredit must be ≥ 1 for \(capability) (a zero budget can never make progress)"))
        }
        return .success(credit)
    }

    /// Typed params as the JSON text the broker validates.
    private func encodeParams<P: Encodable>(_ params: P) -> Result<String, DeviceError> {
        do {
            let json = try DeviceBrokerJSON.encode(params)
            guard json.hasPrefix("{") else {
                return .failure(DeviceError(code: .invalidParams, platformDetail: "params must be an object"))
            }
            return .success(json)
        } catch {
            return .failure(DeviceError(code: .invalidParams, platformDetail: String("\(error)".prefix(512))))
        }
    }

    /// A result the typed layer could not turn into its output value.
    static func outputError(_ error: Error) -> DeviceError {
        if let e = error as? DeviceError { return e }
        return DeviceError(code: .invalidParams, platformDetail: String("\(error)".prefix(512)))
    }

    // MARK: Unary

    /// Issue a unary request and await its terminal outcome as a value.
    /// Typed per capability: `request(PermissionQuery(.camera))`. Upload
    /// items come back with their verified bytes. Cancelling the calling task
    /// cancels the request (`cancelled`).
    public func request<C: DeviceUnaryCapability>(_ call: C, options: DeviceRequestOptions = .init()) async
        -> DeviceResult<C.Output>
    {
        let params: String
        switch encodeParams(call.params) {
        case .success(let p): params = p
        case .failure(let e): return .failure(e)
        }
        switch await requestRaw(C.name, paramsJSON: params, options: options) {
        case .failure(let e): return .failure(e)
        case .success(let raw):
            do {
                return .success(DeviceValue(
                    try C.output(resultJSON: raw.value.resultJSON, blobs: raw.value.blobs), simulated: raw.simulated))
            } catch {
                return .failure(DeviceContext.outputError(error))
            }
        }
    }

    /// Untyped unary request for names only known at runtime. Behaves exactly
    /// like `request`: the name and the params (a JSON object text) are
    /// validated against the selected revision by the broker before anything
    /// is sent.
    public func requestUntyped(_ capability: String, paramsJSON: String = "{}",
                               options: DeviceRequestOptions = .init()) async -> DeviceResult<DeviceUntypedResult>
    {
        // Only an object reaches the broker's open JSON; its contents are
        // the broker's to judge.
        guard (try? JSONSerialization.jsonObject(with: Data(paramsJSON.utf8))) is [String: Any] else {
            return .failure(DeviceError(code: .invalidParams, platformDetail: "params must be a JSON object"))
        }
        return await requestRaw(capability, paramsJSON: paramsJSON, options: options)
    }

    /// `requestUntyped` with `Encodable` params.
    public func requestUntyped<P: Encodable>(_ capability: String, params: P,
                                             options: DeviceRequestOptions = .init()) async
        -> DeviceResult<DeviceUntypedResult>
    {
        switch encodeParams(params) {
        case .success(let json): return await requestRaw(capability, paramsJSON: json, options: options)
        case .failure(let e): return .failure(e)
        }
    }

    private func requestRaw(_ capability: String, paramsJSON: String, options: DeviceRequestOptions) async
        -> DeviceResult<DeviceUntypedResult>
    {
        if let e = guardError() { return .failure(e) }
        if Task.isCancelled { return .failure(.cancelled) }
        let plane = self.plane!
        let owner = self.owner!
        guard let version = plane.selectedVersion(capability) else { return .failure(.unsupported) }
        let rev = plane.revision(capability, version: version)
        let credit: UInt64?
        switch wireCredit(capability, rev?.data, options) {
        case .success(let c): credit = c
        case .failure(let e): return .failure(e)
        }
        // The broker admits or refuses (lifetime, pin cap, operation shape —
        // a stream or a download is refused here — params, deadline and
        // credit clamps), in that order, before anything is sent.
        let spec = DevicePlaneOpenSpec(
            capability: capability, version: version, paramsJSON: paramsJSON,
            moduleInstanceId: owner.moduleInstanceId, activationId: owner.activationId,
            lifetime: options.lifetime, timeoutMs: options.timeoutMs.map { max(1, $0) },
            initialCredit: credit, mode: .unary, holdResult: true, replayed: false)
        let id: UInt32
        let box: DeviceSettlementBox
        switch plane.open(spec) {
        case .refused(let e): return .failure(e)
        case .opened(let i, let b): id = i; box = b
        }
        // Activation-owned unary work is scoped to the invoking handler;
        // `background` work is detached from it (owned by the module
        // instance, swept on destroy) and never scope-cancelled.
        let lifetime = options.lifetime ?? rev?.lifetimes.first ?? .activation
        let scoped: Bool = {
            lock.lock(); defer { lock.unlock() }
            guard scopeOpen, lifetime != .background else { return false }
            scopeCancels[id] = { [weak plane] in plane?.cancel(id) }
            return true
        }()
        let settlement = await withTaskCancellationHandler {
            await box.wait()
        } onCancel: { [weak plane] in
            plane?.cancel(id)
        }
        if scoped {
            _ = lock.withLock { scopeCancels.removeValue(forKey: id) }
        }
        switch settlement {
        case .failure(let e):
            return .failure(e)
        case .success(let resultJSON, let blobs, let simulated, let release):
            if let release {
                let deferRelease: Bool = lock.withLock {
                    let d = scoped && scopeOpen
                    if d { scopeReleases.append(release) }
                    return d
                }
                // The bytes are already Swift `Data`: outside a scope the
                // charge is released at delivery.
                if !deferRelease { release() }
            }
            return .success(DeviceValue(DeviceUntypedResult(resultJSON: resultJSON, blobs: blobs), simulated: simulated))
        }
    }

    // MARK: Streams

    private func openStream<Element: Sendable>(
        _ capability: String, params: String, options: DeviceRequestOptions,
        expecting data: DeviceDataPlane, buffer: DeviceStreamBuffer<Element>
    ) -> DeviceStreamCore<Element> {
        func refused(_ e: DeviceError) -> DeviceStreamCore<Element> {
            DeviceStreamCore(id: nil, buffer: DeviceStreamBuffer<Element>.finishedBuffer(),
                             settlement: DeviceSettlementBox(.failure(e)), cancel: {})
        }
        if let e = guardError() { return refused(e) }
        if Task.isCancelled { return refused(.cancelled) }
        let plane = self.plane!
        let owner = self.owner!
        guard let version = plane.selectedVersion(capability) else { return refused(.unsupported) }
        let rev = plane.revision(capability, version: version)
        guard rev?.mode == .stream, rev?.data == data else {
            return refused(DeviceError(
                code: .invalidParams,
                platformDetail: data == .jsonEvents
                    ? "\(capability) is not a JSON event stream"
                    : "\(capability) is not a binary-upload stream"))
        }
        let credit: UInt64?
        switch wireCredit(capability, rev?.data, options) {
        case .success(let c): credit = c
        case .failure(let e): return refused(e)
        }
        buffer.plane = plane
        let spec = DevicePlaneOpenSpec(
            capability: capability, version: version, paramsJSON: params,
            moduleInstanceId: owner.moduleInstanceId, activationId: owner.activationId,
            lifetime: options.lifetime, timeoutMs: options.timeoutMs.map { max(1, $0) },
            initialCredit: credit, mode: .stream, holdResult: false, replayed: false)
        switch plane.open(spec, consumer: buffer) {
        case .refused(let e):
            return refused(e)
        case .opened(let id, let box):
            buffer.id = id
            return DeviceStreamCore(id: id, buffer: buffer, settlement: box,
                                    cancel: { [weak plane] in plane?.cancel(id) })
        }
    }

    /// Open a JSON event stream, typed per capability:
    /// `for await device in ctx.device.stream(BluetoothScan()) { … }`.
    /// Each event was validated by the broker against the revision's event
    /// schema; event credit returns as the loop advances.
    public func stream<C: DeviceEventStreamCapability>(_ call: C, options: DeviceRequestOptions = .init())
        -> DeviceEventStream<C.Event, C.Output>
    {
        let output: @Sendable (String) throws -> C.Output = { try C.output(resultJSON: $0) }
        let params: String
        switch encodeParams(call.params) {
        case .success(let p): params = p
        case .failure(let e):
            return DeviceEventStream(core: DeviceStreamCore(
                id: nil, buffer: .finishedBuffer(), settlement: DeviceSettlementBox(.failure(e)), cancel: {}),
                output: output)
        }
        let buffer = DeviceStreamBuffer<C.Event>(isData: false, event: { json in C.event(eventJSON: json) })
        let core = openStream(C.name, params: params, options: options, expecting: .jsonEvents, buffer: buffer)
        return DeviceEventStream(core: core, output: output)
    }

    /// Open a binary-upload stream, typed per capability:
    /// `for await chunk in ctx.device.stream(MicRecord(sampleRate: 16000)) { … }`.
    public func stream<C: DeviceDataStreamCapability>(_ call: C, options: DeviceRequestOptions = .init())
        -> DeviceDataStream<C.Output>
    {
        let output: @Sendable (String) throws -> C.Output = { try C.output(resultJSON: $0) }
        let params: String
        switch encodeParams(call.params) {
        case .success(let p): params = p
        case .failure(let e):
            return DeviceDataStream(core: DeviceStreamCore(
                id: nil, buffer: .finishedBuffer(), settlement: DeviceSettlementBox(.failure(e)), cancel: {}),
                output: output)
        }
        let buffer = DeviceStreamBuffer<DeviceDataChunk>(isData: true, data: { channel, bytes in
            DeviceDataChunk(channel: channel, bytes: bytes)
        })
        let core = openStream(C.name, params: params, options: options, expecting: .binaryUpload, buffer: buffer)
        return DeviceDataStream(core: core, output: output)
    }

    // MARK: Downloads

    /// Save bytes on the device (`file.save`, RFC 001 §2.4 downloads). The
    /// request announces `{channel:0, name, contentType, bytes, sha256}`
    /// (built by the engine, `deviceFileSaveParamsJson`) with zero initial
    /// credit; the broker validates the announcement and the download size
    /// against the selected revision, sends ≤ 64 KiB frames only within
    /// credit the client grants after consent and destination selection, and
    /// verifies the client's `bytesWritten` before settling.
    public func save(_ bytes: Data, name: String, contentType: String, timeoutMs: UInt64? = nil) async
        -> DeviceResult<FileSaveResult>
    {
        let capability = "file.save"
        if let e = guardError() { return .failure(e) }
        if Task.isCancelled { return .failure(.cancelled) }
        let plane = self.plane!
        let owner = self.owner!
        guard let version = plane.selectedVersion(capability) else { return .failure(.unsupported) }
        // Transport knowledge, not protocol: frames need a binary route.
        guard plane.canSendBinary else {
            return .failure(DeviceError(code: .unsupported, platformDetail: "no binary route"))
        }
        let announcement = deviceFileSaveParamsJson(name: name, contentType: contentType, bytes: bytes)
        // Authority is re-checked after hashing: a continuation resuming after
        // deactivation/close cannot start new device work (§2.7).
        if let e = guardError() { return .failure(e) }
        let spec = DevicePlaneOpenSpec(
            capability: capability, version: version, paramsJSON: announcement,
            moduleInstanceId: owner.moduleInstanceId, activationId: owner.activationId,
            lifetime: nil, timeoutMs: timeoutMs.map { max(1, $0) }, initialCredit: nil, mode: .unary,
            holdResult: false, replayed: false, download: bytes)
        let id: UInt32
        let box: DeviceSettlementBox
        switch plane.open(spec) {
        case .refused(let e): return .failure(e)
        case .opened(let i, let b): id = i; box = b
        }
        let settlement = await withTaskCancellationHandler {
            await box.wait()
        } onCancel: { [weak plane] in
            plane?.cancel(id)
        }
        switch settlement {
        case .failure(let e): return .failure(e)
        case .success(let resultJSON, _, let simulated, let release):
            release?()
            do {
                return .success(DeviceValue(try DeviceBrokerJSON.decode(FileSaveResult.self, from: resultJSON),
                                            simulated: simulated))
            } catch {
                return .failure(DeviceContext.outputError(error))
            }
        }
    }

    // MARK: Convenience wrappers

    /// `permission.query` / `permission.request` over the closed enum.
    public var permissions: Permissions { Permissions(ctx: self) }
    /// `camera.capture`.
    public var camera: Camera { Camera(ctx: self) }
    /// `mic.record`.
    public var mic: Mic { Mic(ctx: self) }
    /// `bluetooth.select` / `bluetooth.scan`.
    public var bluetooth: Bluetooth { Bluetooth(ctx: self) }
    /// `gallery.pick`.
    public var gallery: Gallery { Gallery(ctx: self) }
    /// `file.pick` / `file.save`.
    public var files: Files { Files(ctx: self) }

    public struct Permissions: Sendable {
        let ctx: DeviceContext
        public func query(_ permission: Permission, options: DeviceRequestOptions = .init()) async
            -> DeviceResult<PermissionResult> { await ctx.request(PermissionQuery(permission), options: options) }
        public func request(_ permission: Permission, options: DeviceRequestOptions = .init()) async
            -> DeviceResult<PermissionResult> { await ctx.request(PermissionRequest(permission), options: options) }
    }

    public struct Camera: Sendable {
        let ctx: DeviceContext
        /// One photo or video through the host's own capture UI.
        public func capture(_ mode: CaptureMode, facing: CameraFacing? = nil, maxDurationMs: UInt64? = nil,
                            options: DeviceRequestOptions = .init()) async -> DeviceResult<DeviceReceivedBlob> {
            await ctx.request(CameraCapture(mode: mode, facing: facing, maxDurationMs: maxDurationMs), options: options)
        }
    }

    public struct Mic: Sendable {
        let ctx: DeviceContext
        /// A PCM16 recording streamed in order; iterate it for the bytes.
        public func record(sampleRate: UInt32, channels: UInt8? = nil, maxDurationMs: UInt64? = nil,
                           options: DeviceRequestOptions = .init()) -> DeviceDataStream<MicRecordResult> {
            ctx.stream(MicRecord(sampleRate: sampleRate, channels: channels, maxDurationMs: maxDurationMs), options: options)
        }
    }

    public struct Bluetooth: Sendable {
        let ctx: DeviceContext
        /// The identity of one device the user chose in the host chooser.
        public func select(services: [String]? = nil, namePrefix: String? = nil,
                           options: DeviceRequestOptions = .init()) async -> DeviceResult<SelectedBluetoothDevice> {
            await ctx.request(BluetoothSelect(services: services, namePrefix: namePrefix), options: options)
        }
        /// Advertisements as the device sees them.
        public func scan(options: DeviceRequestOptions = .init()) -> DeviceEventStream<BluetoothDevice, BluetoothScanResult> {
            ctx.stream(BluetoothScan(), options: options)
        }
    }

    public struct Gallery: Sendable {
        let ctx: DeviceContext
        public func pick(_ mediaTypes: [MediaType] = [.photo], maxCount: UInt16 = 1,
                         options: DeviceRequestOptions = .init()) async -> DeviceResult<DevicePickedItems> {
            await ctx.request(GalleryPick(mediaTypes: mediaTypes, maxCount: maxCount), options: options)
        }
    }

    public struct Files: Sendable {
        let ctx: DeviceContext
        public func pick(accept: [String] = [], maxCount: UInt16 = 1,
                         options: DeviceRequestOptions = .init()) async -> DeviceResult<DevicePickedItems> {
            await ctx.request(FilePick(accept: accept, maxCount: maxCount), options: options)
        }
        public func save(_ bytes: Data, name: String, contentType: String, timeoutMs: UInt64? = nil) async
            -> DeviceResult<FileSaveResult> {
            await ctx.save(bytes, name: name, contentType: contentType, timeoutMs: timeoutMs)
        }
    }
}

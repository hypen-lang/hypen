// Device Capability Protocol — iOS backends for the round-3 capability
// drivers (RFC 001 §2.4, §3, §5): UIDocumentPicker for `file.pick` and the
// `file.save` destination, UIImagePickerController for `camera.capture`,
// AVAudioEngine + AVAudioConverter for `mic.record`, and a host-owned
// chooser over a live CoreBluetooth scan for `bluetooth.select`.
//
// The protocol logic lives in `DeviceCaptureDrivers.swift` (Linux-tested
// through fakes); this file only adapts the OS. Compiled on iOS only.
//
// OS callbacks that may run off the main queue are explicit `@Sendable`
// closures that hop with `Task { @MainActor in }` (see DeviceHostIOS.swift).

#if canImport(UIKit) && os(iOS)
import Foundation
import UIKit
import UniformTypeIdentifiers
@preconcurrency import AVFoundation
@preconcurrency import CoreBluetooth

// MARK: - Shared file helpers

enum DeviceFileSupport {
    static func mimeType(for url: URL) -> String {
        if let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType,
           let mime = type.preferredMIMEType {
            return mime
        }
        return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    /// UTTypes for parsed `accept` filters; `[.item]` when unfiltered.
    static func contentTypes(_ filters: [DocumentTypeFilter]) -> [UTType] {
        guard !filters.isEmpty else { return [.item] }
        var types: [UTType] = []
        for filter in filters {
            let type: UTType?
            switch filter {
            case let .mimeType(mime):
                type = UTType(mimeType: mime)
            case let .mediaWildcard(media):
                switch media {
                case "image": type = .image
                case "video": type = .movie
                case "audio": type = .audio
                case "text": type = .text
                case "font": type = .font
                case "application": type = .data
                default: type = nil
                }
            case let .fileExtension(ext):
                type = UTType(filenameExtension: ext)
            }
            if let type = type, !types.contains(type) { types.append(type) }
        }
        // Every entry unknown to the system: dynamic types that match nothing
        // would leave an unusable picker; `.data` is still narrower than
        // `.item` (no folders/packages).
        return types.isEmpty ? [.data] : types
    }
}

/// Retains an OS delegate for the lifetime of its presentation.
@MainActor
private final class DelegateRetainer {
    static let shared = DelegateRetainer()
    private var live: [ObjectIdentifier: AnyObject] = [:]
    func retain(_ object: AnyObject) { live[ObjectIdentifier(object)] = object }
    func release(_ object: AnyObject) { live[ObjectIdentifier(object)] = nil }
}

// MARK: - file.pick (UIDocumentPickerViewController, open)

/// `NSFileCoordinator` read coordination: waits for writers (file
/// providers, iCloud) to finish, materialises an iCloud placeholder before
/// the read, and can be abandoned from any thread when the operation ends.
final class SystemFileReadCoordinator: DeviceFileReadCoordinator, @unchecked Sendable {
    private let coordinator = NSFileCoordinator(filePresenter: nil)

    func coordinateReading(at url: URL, _ reader: (URL) -> Void) -> Bool {
        var error: NSError?
        var ran = false
        coordinator.coordinate(readingItemAt: url, options: [], error: &error) { readable in
            ran = true
            reader(readable)
        }
        return ran && error == nil
    }

    func cancel() { coordinator.cancel() }
}

/// `UIDocumentPickerViewController(forOpeningContentTypes:asCopy: false)`:
/// the original is never mapped in place (a file provider, iCloud or another
/// process could truncate it mid-upload and SIGBUS the app, and its data
/// protection class is not the host's). Each security-scoped URL is read
/// under `NSFileCoordinator` (iCloud placeholders are downloaded first),
/// size-checked before any byte is copied, cloned to a private first-unlock
/// file that is unlinked at once, and only the clone is memory-mapped
/// (`DeviceDocumentLoader`); security-scoped access ends as soon as the clone
/// exists. `asCopy: false` keeps the size check ahead of any copy (the
/// system's own copy would duplicate an oversized file first).
@MainActor
public final class UIDocumentOpenPicker: DocumentPicker {
    private let presenter: @MainActor () -> UIViewController?

    public init(presenter: @escaping @MainActor () -> UIViewController? = DeviceUIKitPresentation.topViewController) {
        self.presenter = presenter
    }

    public func presentOpen(filters: [DocumentTypeFilter],
                            maxCount: Int,
                            maxItemBytes: UInt64,
                            selected: @escaping @Sendable @MainActor () -> Void,
                            completion: @escaping @Sendable @MainActor (DocumentPickOutcome) -> Void) -> DeviceCancellable? {
        // Nothing on screen that could ever present (background, no scene);
        // a host that is mid-transition is waited for by `present`.
        guard presenter() != nil else { return nil }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: DeviceFileSupport.contentTypes(filters),
                                                    asCopy: false)
        picker.allowsMultipleSelection = maxCount > 1
        let session = OpenPickerSession(picker: picker, maxCount: maxCount, maxItemBytes: maxItemBytes,
                                        selected: selected, completion: completion)
        picker.delegate = session
        picker.presentationController?.delegate = session
        DelegateRetainer.shared.retain(session)
        DeviceUIKitPresentation.present(picker, using: presenter) { session.presentationRefused() }
        return session
    }
}

@MainActor
private final class OpenPickerSession: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate,
    DeviceCancellable {
    private weak var picker: UIDocumentPickerViewController?
    private let maxCount: Int
    private let maxItemBytes: UInt64
    private var selected: (@Sendable @MainActor () -> Void)?
    private var completion: (@Sendable @MainActor (DocumentPickOutcome) -> Void)?
    private var loading: Task<Void, Never>?
    private var cancellation: DeviceFileLoadCancellation?

    init(picker: UIDocumentPickerViewController, maxCount: Int, maxItemBytes: UInt64,
         selected: @escaping @Sendable @MainActor () -> Void,
         completion: @escaping @Sendable @MainActor (DocumentPickOutcome) -> Void) {
        self.picker = picker
        self.maxCount = maxCount
        self.maxItemBytes = maxItemBytes
        self.selected = selected
        self.completion = completion
        super.init()
    }

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        Task { @MainActor in self.picked(urls) }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        Task { @MainActor in self.finish(.dismissed) }
    }

    nonisolated func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        Task { @MainActor in self.finish(.dismissed) }
    }

    func presentationRefused() {
        guard completion != nil, selected != nil else { return }
        if let picker = picker, picker.presentingViewController != nil { return }
        finish(.presentationFailed)
    }

    private func picked(_ urls: [URL]) {
        guard completion != nil else { return }
        guard !urls.isEmpty else {
            finish(.dismissed)
            return
        }
        let chose = selected
        selected = nil
        chose?()
        guard completion != nil else { return }
        let chosen = Array(urls.prefix(maxCount))
        let limit = maxItemBytes
        let cancellation = DeviceFileLoadCancellation()
        self.cancellation = cancellation
        loading = Task.detached(priority: .userInitiated) { [weak self] in
            let outcome = DeviceDocumentLoader.load(
                chosen, limit: limit, cancellation: cancellation,
                makeCoordinator: { SystemFileReadCoordinator() },
                access: { url in
                    let scoped = url.startAccessingSecurityScopedResource()
                    return { if scoped { url.stopAccessingSecurityScopedResource() } }
                },
                contentType: { DeviceFileSupport.mimeType(for: $0) })
            await MainActor.run {
                guard let self = self, self.completion != nil, let outcome = outcome else { return }
                self.finish(outcome)
            }
        }
    }

    private func finish(_ outcome: DocumentPickOutcome) {
        guard let completion = completion else { return }
        self.completion = nil
        selected = nil
        DelegateRetainer.shared.release(self)
        completion(outcome)
    }

    func cancel() {
        completion = nil
        selected = nil
        cancellation?.cancel()
        cancellation = nil
        loading?.cancel()
        loading = nil
        if let picker = picker, picker.presentingViewController != nil {
            picker.dismiss(animated: true)
        }
        DelegateRetainer.shared.release(self)
    }
}

// MARK: - file.save (UIDocumentPickerViewController, export)

/// Destination first: an empty placeholder named after the (sanitized) file
/// is exported with `UIDocumentPickerViewController(forExporting:asCopy:
/// false)`, so the user picks the folder (and confirms the name) before any
/// byte is granted. The download then streams into a private temp file;
/// after verification its bytes replace the placeholder's contents at the
/// chosen location under coordinated, security-scoped access. Any other end
/// deletes the temp file and the placeholder.
@MainActor
public final class UIDocumentExportDestinationPicker: FileSaveDestinationPicker {
    private let presenter: @MainActor () -> UIViewController?

    public init(presenter: @escaping @MainActor () -> UIViewController? = DeviceUIKitPresentation.topViewController) {
        self.presenter = presenter
    }

    public func chooseDestination(name: String,
                                  contentType: String,
                                  bytes: UInt64,
                                  completion: @escaping @MainActor (FileSaveDestinationOutcome) -> Void) -> DeviceCancellable? {
        // Nothing on screen that could ever present (background, no scene).
        // A host that is merely mid-transition is waited for below.
        guard presenter() != nil else { return nil }
        let staging = FileManager.default.temporaryDirectory
            .appendingPathComponent("hypen-save-\(UUID().uuidString)", isDirectory: true)
        let placeholder = staging.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            guard FileManager.default.createFile(atPath: placeholder.path, contents: Data()) else {
                throw CocoaError(.fileWriteUnknown)
            }
        } catch {
            try? FileManager.default.removeItem(at: staging)
            completion(.failed("staging-failed"))
            return FinishedHandle()
        }
        let picker = UIDocumentPickerViewController(forExporting: [placeholder], asCopy: false)
        let session = ExportPickerSession(picker: picker, staging: staging, completion: completion)
        picker.delegate = session
        picker.presentationController?.delegate = session
        DelegateRetainer.shared.retain(session)
        session.present(using: presenter)
        return session
    }
}

@MainActor
private final class FinishedHandle: DeviceCancellable {
    func cancel() {}
}

@MainActor
private final class ExportPickerSession: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate,
    DeviceCancellable {
    // Strong until the session finishes: the picker may not be on screen
    // yet while the session waits for a presentable host.
    private var picker: UIDocumentPickerViewController?
    private let staging: URL
    private var completion: (@MainActor (FileSaveDestinationOutcome) -> Void)?

    init(picker: UIDocumentPickerViewController, staging: URL,
         completion: @escaping @MainActor (FileSaveDestinationOutcome) -> Void) {
        self.picker = picker
        self.staging = staging
        self.completion = completion
        super.init()
    }

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        Task { @MainActor in self.picked(urls.first) }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        Task { @MainActor in self.finish(.dismissed) }
    }

    nonisolated func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        Task { @MainActor in self.finish(.dismissed) }
    }

    /// Present the picker (waiting for a prompt that is still animating
    /// away, see `DeviceUIKitPresentation.present`).
    func present(using presenter: @escaping @MainActor () -> UIViewController?) {
        guard let picker = picker else { return }
        DeviceUIKitPresentation.present(picker, using: presenter) { [self] in
            finish(.presentationFailed)
        }
    }

    private func picked(_ destination: URL?) {
        guard completion != nil else {
            // Settled while the picker was open: the placeholder was moved; remove it.
            if let destination = destination { ExportedFileSink.removeDestination(destination) }
            return
        }
        guard let destination = destination else {
            finish(.dismissed)
            return
        }
        guard let sink = ExportedFileSink(destination: destination) else {
            ExportedFileSink.removeDestination(destination)
            finish(.failed("temp-file-failed"))
            return
        }
        finish(.chosen(sink))
    }

    private func finish(_ outcome: FileSaveDestinationOutcome) {
        guard let completion = completion else { return }
        self.completion = nil
        picker = nil
        try? FileManager.default.removeItem(at: staging)
        DelegateRetainer.shared.release(self)
        completion(outcome)
    }

    func cancel() {
        completion = nil
        if let picker = picker, picker.presentingViewController != nil {
            picker.dismiss(animated: true)
        }
        picker = nil
        try? FileManager.default.removeItem(at: staging)
        DelegateRetainer.shared.release(self)
    }
}

/// Download sink: a private temp file written on a serial queue (bounded
/// memory: only the chunks in flight), published to the destination only on
/// `commit`.
@MainActor
final class ExportedFileSink: DeviceFileSink {
    private let destination: URL
    private let temp: URL
    private let queue = DispatchQueue(label: "space.hypen.device.file-save")
    private let handle: FileHandleBox
    private var finished = false

    init?(destination: URL) {
        self.destination = destination
        temp = FileManager.default.temporaryDirectory.appendingPathComponent("hypen-download-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: temp.path, contents: nil),
              let handle = try? FileHandle(forWritingTo: temp) else {
            try? FileManager.default.removeItem(at: temp)
            return nil
        }
        self.handle = FileHandleBox(handle)
    }

    func write(_ data: Data, completion: @escaping @Sendable @MainActor (Bool) -> Void) {
        let box = handle
        queue.async {
            let ok = box.write(data)
            Task { @MainActor in completion(ok) }
        }
    }

    func commit(completion: @escaping @Sendable @MainActor (Bool) -> Void) {
        guard !finished else { return completion(false) }
        let box = handle
        let temp = self.temp
        let destination = self.destination
        queue.async {
            let ok = box.close() && ExportedFileSink.publish(temp, to: destination)
            try? FileManager.default.removeItem(at: temp)
            Task { @MainActor in completion(ok) }
        }
        finished = true
    }

    func discard() {
        guard !finished else { return }
        finished = true
        let box = handle
        let temp = self.temp
        let destination = self.destination
        queue.async {
            _ = box.close()
            try? FileManager.default.removeItem(at: temp)
            ExportedFileSink.removeDestination(destination)
        }
    }

    /// Copy `temp` over the destination placeholder in 64 KiB slices under a
    /// coordinated, security-scoped write.
    nonisolated static func publish(_ temp: URL, to destination: URL) -> Bool {
        let scoped = destination.startAccessingSecurityScopedResource()
        defer { if scoped { destination.stopAccessingSecurityScopedResource() } }
        var ok = false
        var coordinationError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: destination, options: .forReplacing,
                                                          error: &coordinationError) { url in
            guard let input = try? FileHandle(forReadingFrom: temp),
                  let output = try? FileHandle(forWritingTo: url) else { return }
            defer {
                try? input.close()
                try? output.close()
            }
            do {
                try output.truncate(atOffset: 0)
                while let chunk = try input.read(upToCount: 64 * 1024), !chunk.isEmpty {
                    try output.write(contentsOf: chunk)
                }
                try output.synchronize()
                ok = true
            } catch {
                ok = false
            }
        }
        if !ok { removeDestination(destination) }
        return ok && coordinationError == nil
    }

    nonisolated static func removeDestination(_ destination: URL) {
        let scoped = destination.startAccessingSecurityScopedResource()
        defer { if scoped { destination.stopAccessingSecurityScopedResource() } }
        var error: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: destination, options: .forDeleting,
                                                          error: &error) { url in
            try? FileManager.default.removeItem(at: url)
        }
    }
}

/// A FileHandle used only on the sink's serial queue.
final class FileHandleBox: @unchecked Sendable {
    private let handle: FileHandle
    private var closed = false

    init(_ handle: FileHandle) { self.handle = handle }

    func write(_ data: Data) -> Bool {
        guard !closed else { return false }
        do {
            try handle.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }

    func close() -> Bool {
        guard !closed else { return true }
        closed = true
        do {
            try handle.synchronize()
            try handle.close()
            return true
        } catch {
            return false
        }
    }
}

// MARK: - camera.capture (UIImagePickerController, camera)

/// The system camera UI: photo (`image/jpeg`) or video (`video/quicktime`,
/// `videoMaximumDuration` from `maxDurationMs`), front/back camera. The
/// captured item is size-checked and memory-mapped from a private clone.
@MainActor
public final class ImagePickerCameraCapturer: CameraCapturer {
    private let presenter: @MainActor () -> UIViewController?
    /// JPEG compression quality for photos.
    public let jpegQuality: CGFloat

    public init(presenter: @escaping @MainActor () -> UIViewController? = DeviceUIKitPresentation.topViewController,
                jpegQuality: CGFloat = 0.9) {
        self.presenter = presenter
        self.jpegQuality = jpegQuality
    }

    public func isAvailable(facing: CameraCaptureRequest.Facing?) -> Bool {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { return false }
        switch facing {
        case .front?: return UIImagePickerController.isCameraDeviceAvailable(.front)
        case .back?: return UIImagePickerController.isCameraDeviceAvailable(.rear)
        case nil: return true
        }
    }

    public func presentCapture(_ request: CameraCaptureRequest,
                               maxItemBytes: UInt64,
                               captured: @escaping @Sendable @MainActor () -> Void,
                               completion: @escaping @Sendable @MainActor (CameraCaptureOutcome) -> Void) -> DeviceCancellable? {
        // Nothing on screen that could ever present (background, no scene);
        // a host that is mid-transition is waited for by `present`.
        guard presenter() != nil else { return nil }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        switch request.mode {
        case .photo:
            picker.mediaTypes = [UTType.image.identifier]
            picker.cameraCaptureMode = .photo
        case .video:
            picker.mediaTypes = [UTType.movie.identifier]
            picker.cameraCaptureMode = .video
            picker.videoQuality = .typeHigh
            picker.videoMaximumDuration = request.maxDuration ?? 600
        }
        if let facing = request.facing {
            picker.cameraDevice = facing == .front ? .front : .rear
        }
        let session = CameraSession(picker: picker, mode: request.mode, maxItemBytes: maxItemBytes,
                                    jpegQuality: jpegQuality, captured: captured, completion: completion)
        picker.delegate = session
        DelegateRetainer.shared.retain(session)
        DeviceUIKitPresentation.present(picker, using: presenter) { session.presentationRefused() }
        return session
    }
}

@MainActor
private final class CameraSession: NSObject, @preconcurrency UIImagePickerControllerDelegate,
    @preconcurrency UINavigationControllerDelegate, DeviceCancellable {
    private weak var picker: UIImagePickerController?
    private let mode: CameraCaptureRequest.Mode
    private let maxItemBytes: UInt64
    private let jpegQuality: CGFloat
    private var captured: (@Sendable @MainActor () -> Void)?
    private var completion: (@Sendable @MainActor (CameraCaptureOutcome) -> Void)?
    private var loading: Task<Void, Never>?

    init(picker: UIImagePickerController, mode: CameraCaptureRequest.Mode, maxItemBytes: UInt64, jpegQuality: CGFloat,
         captured: @escaping @Sendable @MainActor () -> Void,
         completion: @escaping @Sendable @MainActor (CameraCaptureOutcome) -> Void) {
        self.picker = picker
        self.mode = mode
        self.maxItemBytes = maxItemBytes
        self.jpegQuality = jpegQuality
        self.captured = captured
        self.completion = completion
        super.init()
    }

    func presentationRefused() {
        guard completion != nil, captured != nil else { return }
        if let picker = picker, picker.presentingViewController != nil { return }
        finish(.presentationFailed)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish(.dismissed)
    }

    func imagePickerController(_ picker: UIImagePickerController,
                               didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard completion != nil else { return }
        let image = info[.originalImage] as? UIImage
        let movie = info[.mediaURL] as? URL
        let chose = captured
        captured = nil
        chose?()
        guard completion != nil else { return }
        let limit = maxItemBytes
        let quality = jpegQuality
        switch mode {
        case .photo:
            guard let image = image else {
                finish(.failed("no-image"))
                return
            }
            let box = ImageBox(image)
            loading = Task.detached(priority: .userInitiated) { [weak self] in
                let outcome: CameraCaptureOutcome
                if let data = box.image.jpegData(compressionQuality: quality), !data.isEmpty {
                    outcome = UInt64(data.count) <= limit
                        ? .captured(PickedMedia(contentType: "image/jpeg", data: data)) : .tooLarge
                } else {
                    outcome = .failed("encode-failed")
                }
                await MainActor.run { self?.finish(outcome) }
            }
        case .video:
            guard let movie = movie else {
                finish(.failed("no-movie"))
                return
            }
            loading = Task.detached(priority: .userInitiated) { [weak self] in
                let outcome: CameraCaptureOutcome
                switch DeviceFileClone.mappedClone(of: movie, limit: limit) {
                case let .success(data):
                    let type = movie.pathExtension.lowercased() == "mp4" ? "video/mp4" : "video/quicktime"
                    outcome = .captured(PickedMedia(contentType: type, data: data))
                case .failure(.tooLarge):
                    outcome = .tooLarge
                case let .failure(.failed(detail)):
                    outcome = .failed(detail)
                }
                try? FileManager.default.removeItem(at: movie)
                await MainActor.run { self?.finish(outcome) }
            }
        }
    }

    private func finish(_ outcome: CameraCaptureOutcome) {
        guard let completion = completion else { return }
        self.completion = nil
        captured = nil
        DelegateRetainer.shared.release(self)
        completion(outcome)
    }

    func cancel() {
        completion = nil
        captured = nil
        loading?.cancel()
        loading = nil
        if let picker = picker, picker.presentingViewController != nil {
            picker.dismiss(animated: true)
        }
        DelegateRetainer.shared.release(self)
    }
}

/// UIImage is immutable once captured; encoded off the main actor.
private final class ImageBox: @unchecked Sendable {
    let image: UIImage
    init(_ image: UIImage) { self.image = image }
}

// MARK: - mic.record (AVAudioEngine + AVAudioConverter → PCM16)

@MainActor
public final class AVAudioEngineCaptureFactory: AudioCaptureFactory {
    public init() {}
    public func makeSource() -> AudioCaptureSource { AVAudioEngineCaptureSource() }
}

/// An input tap on `AVAudioEngine`, converted by `AVAudioConverter` to
/// interleaved little-endian PCM16 at the requested rate and channel count.
/// OS interruptions, route loss and engine reconfiguration end the recording
/// (`interrupted`: a normal end with what was captured).
@MainActor
final class AVAudioEngineCaptureSource: AudioCaptureSource {
    private var engine: AVAudioEngine?
    private var observers: [NSObjectProtocol] = []
    private var handler: (@Sendable @MainActor (AudioCaptureEvent) -> Void)?

    func start(_ format: AudioCaptureFormat,
               _ handler: @escaping @Sendable @MainActor (AudioCaptureEvent) -> Void) -> String? {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)
        } catch {
            return "audio-session"
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0,
              let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(format.sampleRate),
                                            channels: AVAudioChannelCount(format.channels), interleaved: true),
              let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            return "no-input"
        }
        if inFormat.channelCount == 1, format.channels == 2 {
            converter.channelMap = [0, 0] // mono microphone → both channels
        }
        self.handler = handler
        let tap = ConverterBox(converter: converter, outFormat: outFormat)
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { @Sendable buffer, _ in
            guard let data = tap.convert(buffer), !data.isEmpty else { return }
            Task { @MainActor in handler(.samples(data)) }
        }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session,
                                            queue: .main) { @Sendable [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
                .flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
            Task { @MainActor in if began { self?.interrupted() } }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session,
                                            queue: .main) { @Sendable [weak self] note in
            let lost = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) == .oldDeviceUnavailable
            Task { @MainActor in if lost { self?.interrupted() } }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine,
                                            queue: .main) { @Sendable [weak self] _ in
            Task { @MainActor in self?.interrupted() }
        })
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            self.handler = nil
            removeObservers()
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            return "engine-start"
        }
        self.engine = engine
        return nil
    }

    private func interrupted() {
        let handler = self.handler
        stop()
        handler?(.interrupted)
    }

    func stop() {
        handler = nil
        removeObservers()
        if let engine = engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func removeObservers() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
    }
}

/// The converter is used only from the (serial) tap callback.
private final class ConverterBox: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let outFormat: AVAudioFormat

    init(converter: AVAudioConverter, outFormat: AVAudioFormat) {
        self.converter = converter
        self.outFormat = outFormat
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return nil }
        nonisolated(unsafe) var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, error == nil, out.frameLength > 0, let samples = out.int16ChannelData else { return nil }
        // Interleaved: one buffer of frameLength × channels samples.
        let count = Int(out.frameLength) * Int(outFormat.channelCount)
        return DevicePCM16.littleEndianBytes(UnsafeBufferPointer(start: samples[0], count: count))
    }
}

// MARK: - bluetooth.select (host-owned chooser)

/// A sheet listing the live scan, naming the origin, with Cancel. It is the
/// visible UI for the whole scan (it closes when the scan stops).
@MainActor
public final class SheetBluetoothChooser: BluetoothChooser {
    private let presenter: @MainActor () -> UIViewController?

    public init(presenter: @escaping @MainActor () -> UIViewController? = DeviceUIKitPresentation.topViewController) {
        self.presenter = presenter
    }

    public func presentChooser(origin: String,
                               completion: @escaping @Sendable @MainActor (BluetoothChooserOutcome) -> Void) -> BluetoothChooserSession? {
        // Nothing on screen that could ever present (background, no scene);
        // a host that is mid-transition is waited for by `present`.
        guard presenter() != nil else { return nil }
        let list = BluetoothChooserViewController(origin: origin, completion: completion)
        let nav = UINavigationController(rootViewController: list)
        nav.modalPresentationStyle = .formSheet
        nav.presentationController?.delegate = list
        DeviceUIKitPresentation.present(nav, using: presenter) { list.presentationRefused() }
        return list
    }
}

@MainActor
private final class BluetoothChooserViewController: UITableViewController, UIAdaptivePresentationControllerDelegate,
    BluetoothChooserSession {
    private let origin: String
    private var completion: (@Sendable @MainActor (BluetoothChooserOutcome) -> Void)?
    private var entries: [BluetoothChooserEntry] = []

    init(origin: String, completion: @escaping @Sendable @MainActor (BluetoothChooserOutcome) -> Void) {
        self.origin = origin
        self.completion = completion
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Choose a device"
        navigationItem.prompt = "\(origin) wants to connect to a Bluetooth device"
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self,
                                                           action: #selector(cancelTapped))
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "device")
    }

    func presentationRefused() {
        guard completion != nil else { return }
        if navigationController?.presentingViewController != nil { return }
        finish(.unavailable)
    }

    func update(_ entries: [BluetoothChooserEntry]) {
        self.entries = entries
        if isViewLoaded { tableView.reloadData() }
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        max(1, entries.count)
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        "Nearby devices"
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "device", for: indexPath)
        var content = cell.defaultContentConfiguration()
        if entries.isEmpty {
            content.text = "Searching…"
            cell.selectionStyle = .none
            cell.accessibilityTraits = .staticText
        } else {
            let entry = entries[indexPath.row]
            content.text = entry.name.flatMap { $0.isEmpty ? nil : $0 } ?? "Unnamed device"
            content.secondaryText = "Signal \(entry.rssi) dBm"
            cell.selectionStyle = .default
            cell.accessibilityTraits = .button
        }
        cell.contentConfiguration = content
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard entries.indices.contains(indexPath.row) else { return }
        let id = entries[indexPath.row].id
        dismiss(animated: true)
        finish(.selected(id: id))
    }

    @objc private func cancelTapped() {
        dismiss(animated: true)
        finish(.dismissed)
    }

    nonisolated func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        Task { @MainActor in self.finish(.dismissed) }
    }

    private func finish(_ outcome: BluetoothChooserOutcome) {
        guard let completion = completion else { return }
        self.completion = nil
        completion(outcome)
    }

    /// The operation ended elsewhere (or the driver closed the chooser).
    func cancel() {
        completion = nil
        if let nav = navigationController, nav.presentingViewController != nil, !nav.isBeingDismissed {
            nav.dismiss(animated: true)
        }
    }
}

// MARK: - Host recording / scanning indicator (RFC 001 §5)

/// The iOS surface of `HostDeviceActivityIndicator`: a passthrough window
/// above every window the app presents (alerts included), on the
/// foreground-active scene, listing each running stream as a pill that names
/// the origin and the host's activity label, with a Stop button. Only the
/// pills take touches; the app underneath stays usable. App content cannot
/// cover it (it is not part of the patch tree or of any app window). When
/// its scene goes to the background or disconnects the overlay reports
/// itself lost and every stream stops. `canShow` is whether a foreground
/// scene exists now; every scene connect/disconnect and foreground/
/// background transition is reported through `readinessHandler`, so the
/// host re-advertises `bluetooth.scan` / `mic.record` accordingly.
@MainActor
public final class UIKitDeviceActivityOverlay: DeviceActivityIndicatorSurface {
    public var stopHandler: (@Sendable @MainActor (UInt64) -> Void)?
    public var lostHandler: (@Sendable @MainActor () -> Void)?
    public var readinessHandler: (@Sendable @MainActor () -> Void)?

    private let sceneProvider: @MainActor () -> UIWindowScene?
    private var window: ActivityOverlayWindow?
    private var controller: ActivityOverlayViewController?
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
    private var sceneChanges: NotificationObservation?

    /// - Parameter scene: the scene to show the overlay on (default: the
    ///   foreground window scene, preferring the active one).
    public init(scene: @escaping @MainActor () -> UIWindowScene? = UIKitDeviceActivityOverlay.foregroundActiveScene) {
        self.sceneProvider = scene
        sceneChanges = NotificationObservation(names: [
            UIScene.willConnectNotification,
            UIScene.didDisconnectNotification,
            UIScene.willEnterForegroundNotification,
            UIScene.didActivateNotification,
            UIScene.willDeactivateNotification,
            UIScene.didEnterBackgroundNotification,
        ]) { [weak self] in self?.readinessHandler?() }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    public var canShow: Bool {
        if let window = window, !window.isHidden, let scene = window.windowScene {
            return Self.onScreen(scene)
        }
        return sceneProvider().map { Self.onScreen($0) } ?? false
    }

    /// The foreground-active window scene, else a foreground-inactive one
    /// (on screen, e.g. while an OS permission alert is being dismissed).
    public static func foregroundActiveScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive }
            ?? scenes.first { $0.activationState == .foregroundInactive }
    }

    /// On screen: the overlay can be seen in this scene.
    private static func onScreen(_ scene: UIWindowScene) -> Bool {
        scene.activationState == .foregroundActive || scene.activationState == .foregroundInactive
    }

    public func render(_ entries: [DeviceActivityIndicatorEntry]) -> Bool {
        if window == nil {
            guard let scene = sceneProvider(), Self.onScreen(scene) else { return false }
            let controller = ActivityOverlayViewController()
            controller.onStop = { [weak self] id in self?.stopHandler?(id) }
            let window = ActivityOverlayWindow(windowScene: scene)
            window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 1)
            window.backgroundColor = .clear
            window.rootViewController = controller
            // Visible without becoming key: the app keeps keyboard focus.
            window.isHidden = false
            self.window = window
            self.controller = controller
            observe(scene)
        }
        guard let window = window, let controller = controller,
              !window.isHidden, let scene = window.windowScene, Self.onScreen(scene) else {
            teardown()
            return false
        }
        controller.show(entries)
        return true
    }

    public func dismiss() {
        teardown()
    }

    private func observe(_ scene: UIWindowScene) {
        for name in [UIScene.didEnterBackgroundNotification, UIScene.didDisconnectNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: scene, queue: .main) {
                @Sendable [weak self] _ in
                Task { @MainActor in self?.lost() }
            })
        }
    }

    private func lost() {
        guard window != nil else { return }
        teardown()
        lostHandler?()
    }

    private func teardown() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        controller = nil
    }
}

/// Lets touches through everywhere except on the overlay's pills.
private final class ActivityOverlayWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self || hit === rootViewController?.view ? nil : hit
    }
}

@MainActor
private final class ActivityOverlayViewController: UIViewController {
    var onStop: (@MainActor (UInt64) -> Void)?
    private let stack = UIStackView()
    private var shown: [DeviceActivityIndicatorEntry] = []

    override func loadView() {
        let root = UIView()
        root.backgroundColor = .clear
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: root.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: root.layoutMarginsGuide.trailingAnchor),
        ])
        view = root
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }

    /// The overlay never decides the status bar: the app's key window does.
    private var appController: UIViewController? {
        guard let windows = view.window?.windowScene?.windows,
              var top = windows.first(where: { $0.isKeyWindow && !($0 is ActivityOverlayWindow) })?.rootViewController
        else { return nil }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }

    override var childForStatusBarStyle: UIViewController? { appController }
    override var childForStatusBarHidden: UIViewController? { appController }

    func show(_ entries: [DeviceActivityIndicatorEntry]) {
        loadViewIfNeeded()
        let added = entries.filter { entry in !shown.contains { $0.id == entry.id } }
        shown = entries
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for entry in entries { stack.addArrangedSubview(pill(for: entry)) }
        for entry in added {
            UIAccessibility.post(notification: .announcement, argument: "\(entry.activity). \(entry.origin)")
        }
    }

    private func pill(for entry: DeviceActivityIndicatorEntry) -> UIView {
        let pill = UIView()
        pill.backgroundColor = .secondarySystemBackground
        pill.layer.cornerRadius = 20
        pill.layer.borderWidth = 1
        pill.layer.borderColor = UIColor.systemRed.cgColor
        pill.layer.shadowColor = UIColor.black.cgColor
        pill.layer.shadowOpacity = 0.2
        pill.layer.shadowRadius = 6
        pill.layer.shadowOffset = CGSize(width: 0, height: 2)

        let dot = UIView()
        dot.backgroundColor = .systemRed
        dot.layer.cornerRadius = 5
        dot.isAccessibilityElement = false
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 10),
            dot.heightAnchor.constraint(equalToConstant: 10),
        ])

        let activity = UILabel()
        activity.text = entry.activity
        activity.font = .preferredFont(forTextStyle: .footnote).withTraits(.traitBold)
        activity.adjustsFontForContentSizeCategory = true
        activity.numberOfLines = 2
        let origin = UILabel()
        origin.text = entry.origin
        origin.font = .preferredFont(forTextStyle: .caption1)
        origin.adjustsFontForContentSizeCategory = true
        origin.textColor = .secondaryLabel
        origin.lineBreakMode = .byTruncatingMiddle
        let labels = UIStackView(arrangedSubviews: [activity, origin])
        labels.axis = .vertical
        labels.spacing = 2
        labels.isAccessibilityElement = true
        labels.accessibilityLabel = "\(entry.activity), \(entry.origin)"

        let stop = StopButton(type: .system)
        stop.entryId = entry.id
        stop.setTitle("Stop", for: .normal)
        stop.titleLabel?.font = .preferredFont(forTextStyle: .body).withTraits(.traitBold)
        stop.titleLabel?.adjustsFontForContentSizeCategory = true
        stop.tintColor = .systemRed
        stop.accessibilityLabel = "Stop: \(entry.activity)"
        stop.addTarget(self, action: #selector(stopTapped(_:)), for: .touchUpInside)
        stop.setContentHuggingPriority(.required, for: .horizontal)
        stop.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = UIStackView(arrangedSubviews: [dot, labels, stop])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: pill.topAnchor, constant: 8),
            row.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -8),
            row.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -12),
            stop.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            stop.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        return pill
    }

    @objc private func stopTapped(_ sender: UIButton) {
        guard let button = sender as? StopButton else { return }
        onStop?(button.entryId)
    }
}

private final class StopButton: UIButton {
    var entryId: UInt64 = 0
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(traits) else { return self }
        return UIFont(descriptor: descriptor, size: 0)
    }
}
#endif

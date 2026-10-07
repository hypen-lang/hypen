// Device Capability Protocol — bounded, SIGBUS-safe reads of user-chosen
// files (RFC 001 §2.4; round-2 mmap-safety rule).
//
// A picked document is never memory-mapped in place: another process, a
// file provider or iCloud can truncate the original while it uploads, and
// touching a mapped page past the new end raises SIGBUS; the original's data
// protection class is not the host's to choose either. Instead the file is
// read under file coordination (which also materialises iCloud
// placeholders), size-checked before a byte is read, copied to a private
// clone whose protection class the host sets, unlinked, and only the clone is
// mapped. The mapping keeps the clone alive until the data is released.
//
// Platform-neutral so it is tested on Linux; iOS injects NSFileCoordinator
// and security-scoped access (DeviceHostIOSCapture.swift).

import Foundation

/// Coordinated read access to one file (NSFileCoordinator on Apple
/// platforms). Implementations must be safe to `cancel()` from any thread.
public protocol DeviceFileReadCoordinator: AnyObject, Sendable {
    /// Run `reader` with a URL that is safe to read for the duration of the
    /// call. Returns false when coordination failed (`reader` did not run).
    func coordinateReading(at url: URL, _ reader: (URL) -> Void) -> Bool
    /// Abandon a pending coordination (the operation was cancelled).
    func cancel()
}

/// Reads without coordination (platforms without file coordination, tests).
public final class DeviceUncoordinatedFileReader: DeviceFileReadCoordinator {
    public init() {}
    public func coordinateReading(at url: URL, _ reader: (URL) -> Void) -> Bool {
        reader(url)
        return true
    }
    public func cancel() {}
}

/// Cancellation shared between a background load and its owner: `cancel()`
/// marks the load cancelled and abandons the coordination in flight.
public final class DeviceFileLoadCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var current: DeviceFileReadCoordinator?

    public init() {}

    public var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    public func cancel() {
        lock.lock()
        cancelled = true
        let active = current
        current = nil
        lock.unlock()
        active?.cancel()
    }

    /// Track `coordinator` while it runs; false when already cancelled.
    func begin(_ coordinator: DeviceFileReadCoordinator) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { return false }
        current = coordinator
        return true
    }

    func end() {
        lock.lock()
        current = nil
        lock.unlock()
    }
}

public enum DeviceFileClone {
    public enum Failure: Error, Sendable, Equatable {
        /// Larger than the limit (checked before reading).
        case tooLarge
        /// A fixed diagnostic token (never OS error text).
        case failed(String)
    }

    /// The directory private clones are created in.
    public static var defaultDirectory: URL { FileManager.default.temporaryDirectory }

    /// Prefix of every private clone's file name.
    public static let clonePrefix = "hypen-device-"

    /// The size of a regular file, nil when unknown or not a regular file.
    public static func regularFileSize(_ url: URL) -> UInt64? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
              values.isRegularFile != false,
              let size = values.fileSize, size >= 0 else { return nil }
        return UInt64(size)
    }

    /// A private, unlinked, memory-mapped clone of `url`, size-checked before
    /// any byte is copied. The clone gets first-unlock data protection: with
    /// the app's default `complete` class, touching unmapped pages after the
    /// device locks raises SIGBUS.
    public static func mappedClone(of url: URL, limit: UInt64,
                                   directory: URL = defaultDirectory) -> Result<Data, Failure> {
        guard let size = regularFileSize(url) else { return .failure(.failed("size-unavailable")) }
        guard size <= limit else { return .failure(.tooLarge) }
        let clone = directory
            .appendingPathComponent("\(clonePrefix)\(UUID().uuidString)")
            .appendingPathExtension(url.pathExtension)
        do {
            try FileManager.default.copyItem(at: url, to: clone)
            defer { try? FileManager.default.removeItem(at: clone) }
            #if canImport(Darwin)
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: clone.path)
            #endif
            // The clone may have grown past the limit if the original was
            // written to while it was copied: re-check before mapping.
            guard let cloned = regularFileSize(clone), cloned <= limit else { return .failure(.tooLarge) }
            let data = try Data(contentsOf: clone, options: .alwaysMapped)
            guard UInt64(data.count) <= limit else { return .failure(.tooLarge) }
            return .success(data)
        } catch {
            try? FileManager.default.removeItem(at: clone)
            return .failure(.failed("read-failed"))
        }
    }

    /// `mappedClone` of `url` read under `coordinator`. A size that is
    /// already known to exceed `limit` fails before coordinating, so an
    /// oversized iCloud placeholder is never downloaded.
    public static func coordinatedClone(of url: URL, limit: UInt64,
                                        coordinator: DeviceFileReadCoordinator,
                                        cancellation: DeviceFileLoadCancellation? = nil,
                                        directory: URL = defaultDirectory) -> Result<Data, Failure> {
        if let known = regularFileSize(url), known > limit { return .failure(.tooLarge) }
        if let cancellation = cancellation, !cancellation.begin(coordinator) {
            return .failure(.failed("cancelled"))
        }
        defer { cancellation?.end() }
        var result: Result<Data, Failure> = .failure(.failed("coordination-failed"))
        let coordinated = coordinator.coordinateReading(at: url) { readable in
            result = mappedClone(of: readable, limit: limit, directory: directory)
        }
        if cancellation?.isCancelled == true { return .failure(.failed("cancelled")) }
        guard coordinated else { return .failure(.failed("coordination-failed")) }
        return result
    }
}

public enum DeviceDocumentLoader {
    /// Load the chosen documents in order as private mapped clones (see
    /// `DeviceFileClone`). `access` opens the platform's access to a URL
    /// (security scope on iOS) and returns its release, which runs as soon as
    /// the clone exists: the upload reads only the clone, never the
    /// original. `contentType` runs while access is open. The first failure
    /// ends the load (clones already made are dropped with their data).
    /// Returns nil when cancelled.
    public static func load(_ urls: [URL],
                            limit: UInt64,
                            cancellation: DeviceFileLoadCancellation,
                            makeCoordinator: () -> DeviceFileReadCoordinator,
                            access: (URL) -> () -> Void,
                            contentType: (URL) -> String,
                            directory: URL = DeviceFileClone.defaultDirectory) -> DocumentPickOutcome? {
        var picked: [PickedDocument] = []
        for url in urls {
            if cancellation.isCancelled { return nil }
            let release = access(url)
            let type = contentType(url)
            let cloned = DeviceFileClone.coordinatedClone(of: url, limit: limit,
                                                          coordinator: makeCoordinator(),
                                                          cancellation: cancellation,
                                                          directory: directory)
            release()
            if cancellation.isCancelled { return nil }
            switch cloned {
            case let .success(data):
                picked.append(PickedDocument(name: url.lastPathComponent, contentType: type, data: data))
            case .failure(.tooLarge):
                return .tooLarge
            case let .failure(.failed(detail)):
                return .failed(detail)
            }
        }
        return .picked(picked)
    }
}

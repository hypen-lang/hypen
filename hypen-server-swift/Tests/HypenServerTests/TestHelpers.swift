import Foundation

/// Thread-safe mutable box for use inside `@Sendable` closures in tests.
///
/// Swift 6 strict concurrency forbids capturing mutable local `var`s inside
/// `@Sendable` closures. Tests frequently need to flip a flag or bump a counter
/// from a handler closure, so we wrap the value in a lock-protected box.
final class TestCounter<T>: @unchecked Sendable {
    private var value: T
    private let lock = NSLock()

    init(_ initial: T) {
        self.value = initial
    }

    var current: T {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ newValue: T) {
        lock.lock()
        defer { lock.unlock() }
        value = newValue
    }

    func mutate(_ transform: (inout T) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        transform(&value)
    }
}

/// Thread-safe append-only string log for verifying lifecycle ordering
/// from inside `@Sendable` closures.
final class TestEventLog: @unchecked Sendable {
    private var events: [String] = []
    private let lock = NSLock()

    func append(_ event: String) {
        lock.lock()
        defer { lock.unlock() }
        events.append(event)
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }
}

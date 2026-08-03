import Foundation

/// A cancellable piece of scheduled animation work.
///
/// Every deferred step in the animation runtime (the exit finalize
/// backbone, completion settles) goes through one of these so a superseding
/// playback can cancel its predecessor's bookkeeping wholesale — the
/// "settle-takeover" pitfall (ANIMATION.md, Pitfalls).
@MainActor
public final class HypenScheduledWork {
    private var cancelImpl: (() -> Void)?

    init(cancel: @escaping () -> Void) {
        self.cancelImpl = cancel
    }

    public func cancel() {
        cancelImpl?()
        cancelImpl = nil
    }
}

/// The clock the animation runtime defers on.
///
/// Production uses the main queue. Tests substitute
/// `HypenManualAnimationScheduler` so the `duration + delay + 80ms`
/// finalize backbone can be driven deterministically instead of slept
/// through.
@MainActor
public class HypenAnimationScheduler {
    public init() {}

    public func schedule(
        after seconds: TimeInterval,
        _ work: @escaping @MainActor () -> Void
    ) -> HypenScheduledWork {
        let item = DispatchWorkItem {
            MainActor.assumeIsolated { work() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, seconds), execute: item)
        return HypenScheduledWork { item.cancel() }
    }
}

/// A virtual-clock scheduler for tests: nothing runs until `advance(by:)`
/// pushes the clock past the work's deadline.
@MainActor
public final class HypenManualAnimationScheduler: HypenAnimationScheduler {
    private final class Entry {
        let deadline: TimeInterval
        let work: @MainActor () -> Void
        var cancelled = false
        init(deadline: TimeInterval, work: @escaping @MainActor () -> Void) {
            self.deadline = deadline
            self.work = work
        }
    }

    private var entries: [Entry] = []
    public private(set) var now: TimeInterval = 0

    public override func schedule(
        after seconds: TimeInterval,
        _ work: @escaping @MainActor () -> Void
    ) -> HypenScheduledWork {
        let entry = Entry(deadline: now + max(0, seconds), work: work)
        entries.append(entry)
        return HypenScheduledWork { entry.cancelled = true }
    }

    /// Advance the virtual clock, running every uncancelled item whose
    /// deadline has passed, in deadline order. Work scheduled by that work
    /// is picked up in the same call if it also falls due.
    public func advance(by seconds: TimeInterval) {
        now += seconds
        var guardCount = 0
        while guardCount < 1000 {
            guardCount += 1
            let due = entries
                .filter { !$0.cancelled && $0.deadline <= now }
                .sorted { $0.deadline < $1.deadline }
            if due.isEmpty { break }
            entries.removeAll { entry in due.contains(where: { $0 === entry }) }
            for entry in due where !entry.cancelled {
                entry.work()
            }
        }
    }

    /// Number of items still waiting (uncancelled, not yet due).
    public var pendingCount: Int {
        entries.filter { !$0.cancelled }.count
    }
}

//! The runtime's one mutex-poisoning policy.
//!
//! A panic on one request thread must not take the dev server down, and a
//! poisoned lock would otherwise turn every later `lock()` into a second
//! panic. Policy: **recover the guard and keep serving**, logging once per
//! poisoning.
//!
//! Why recovery is sound here: every lock in this binary protects either a
//! plain collection that is mutated in single, non-panicking steps (patch
//! mirror, SSE subscriber list, effect outbox, timer heap, UI sources), or the
//! engine. The engine is only ever driven from inside
//! [`Runtime`](crate::app::Runtime) methods; a panic there means an engine or
//! host bug, which is logged loudly — the developer can restart, but the
//! process stays up so the error is visible in the browser instead of as a
//! dropped connection.

use std::sync::{Mutex, MutexGuard};

/// Lock `mutex`, recovering the guard if a previous holder panicked.
/// `what` names the protected state in the log line.
pub fn lock<'a, T>(mutex: &'a Mutex<T>, what: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!(
                "[runtime] a thread panicked while holding the {what} lock; \
                 recovering and continuing (state may be stale — restart if things look wrong)"
            );
            mutex.clear_poison();
            poisoned.into_inner()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_lock_is_recovered_and_cleared() {
        let shared = Arc::new(Mutex::new(vec![1, 2]));
        let poisoner = Arc::clone(&shared);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock();
            panic!("poison the lock");
        })
        .join();
        assert!(shared.is_poisoned());

        lock(&shared, "test").push(3);
        assert_eq!(*lock(&shared, "test"), vec![1, 2, 3]);
        assert!(!shared.is_poisoned(), "recovery clears the poison flag");
    }
}

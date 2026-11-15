//! Cross-module subscriptions (`hypen:engine/state.subscribe`).
//!
//! A subscription says: when `target`'s state changes at (or under, or at an
//! ancestor of) `path`, run `on_change` in `subscriber`. It is owned and
//! authorized by the subscriber — its `reads` grant on the target is checked
//! when the subscription is made — is keyed by scope *name*, and only ever
//! dispatches into the subscriber. So a target may be reloaded, or not be a
//! hosted module at all, without the subscription changing meaning; it ends
//! when the subscriber is re-wired or either side is destroyed.

use super::names::{canonical_scope, ScopeName};
use super::paths::paths_overlap;
use super::registry::HostedModule;
use super::report::{CascadeFailure, FailureCause, Origin};
use super::MAX_SUBSCRIPTIONS_PER_MODULE;
use crate::module_host::SubscribeRequest;
use std::sync::Arc;

struct Subscription {
    subscriber: ScopeName,
    /// Canonical name of the watched scope (hosted or not).
    target: Arc<str>,
    /// Dotted state path; empty watches the whole state.
    path: Arc<str>,
    on_change: String,
}

/// An `on_change` owed to a subscriber because the state it watches changed.
pub(crate) struct Notification {
    pub(crate) subscriber: ScopeName,
    pub(crate) on_change: String,
    pub(crate) target: Arc<str>,
    pub(crate) path: Arc<str>,
}

/// The active subscriptions of every hosted module.
#[derive(Default)]
pub(crate) struct Subscriptions {
    entries: Vec<Subscription>,
}

impl Subscriptions {
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Whether anything watches `target` (canonical).
    pub(crate) fn has_watchers(&self, target: &str) -> bool {
        self.entries.iter().any(|s| &*s.target == target)
    }

    /// Register (or replace) a subscription `subscriber` requested. Replacing
    /// an existing `(subscriber, target, path)` keeps the set idempotent under
    /// repeated `subscribe` calls.
    ///
    /// Observing state is a read, so the subscriber needs its `reads` grant on
    /// the target (re-checked here whatever the host enforced). `on_change`
    /// must be an action the subscriber itself accepts, and a subscriber may
    /// hold at most [`MAX_SUBSCRIPTIONS_PER_MODULE`] subscriptions. A refusal
    /// comes back as the failure to report (boxed: it is the cold path).
    pub(crate) fn add(
        &mut self,
        subscriber: &ScopeName,
        module: &HostedModule,
        request: SubscribeRequest,
    ) -> Result<(), Box<CascadeFailure>> {
        let SubscribeRequest {
            target,
            path,
            on_change,
        } = request;
        let target = canonical_scope(&target);
        let cause = if !module.grants.may_read(&target) {
            Some(FailureCause::ReadDenied {
                missing_grant: target.to_string(),
            })
        } else if !module.actions.accepts(&on_change) {
            Some(FailureCause::NotAccepted)
        } else {
            None
        };
        let refuse = |cause, target: &str, path: String, on_change| {
            Box::new(CascadeFailure {
                scope: subscriber.as_str().to_string(),
                action: on_change,
                origin: Origin::SubscribeRequest {
                    target: target.to_string(),
                    path,
                },
                cause,
            })
        };
        if let Some(cause) = cause {
            return Err(refuse(cause, &target, path, on_change));
        }

        let existing = self
            .entries
            .iter_mut()
            .find(|s| s.subscriber == *subscriber && *s.target == *target && *s.path == *path);
        if let Some(existing) = existing {
            existing.on_change = on_change;
            return Ok(());
        }
        let held = self
            .entries
            .iter()
            .filter(|s| s.subscriber == *subscriber)
            .count();
        if held >= MAX_SUBSCRIPTIONS_PER_MODULE {
            let cause = FailureCause::SubscriptionLimit {
                limit: MAX_SUBSCRIPTIONS_PER_MODULE,
            };
            return Err(refuse(cause, &target, path, on_change));
        }
        self.entries.push(Subscription {
            subscriber: subscriber.clone(),
            target: Arc::from(target.as_ref()),
            path: Arc::from(path),
            on_change,
        });
        Ok(())
    }

    /// The notifications owed when `target`'s state changed at `changed`
    /// paths: one per subscription whose watched path overlaps a changed one,
    /// in subscription order.
    pub(crate) fn notifications_for(&self, target: &str, changed: &[String]) -> Vec<Notification> {
        self.entries
            .iter()
            .filter(|s| &*s.target == target)
            .filter(|s| changed.iter().any(|p| paths_overlap(p, &s.path)))
            .map(|s| Notification {
                subscriber: s.subscriber.clone(),
                on_change: s.on_change.clone(),
                target: Arc::clone(&s.target),
                path: Arc::clone(&s.path),
            })
            .collect()
    }

    /// Drop the subscriptions `scope` made (it was re-wired: the new instance
    /// re-subscribes on demand). Subscriptions others hold *on* it stay.
    pub(crate) fn drop_made_by(&mut self, scope: &str) {
        self.entries.retain(|s| s.subscriber.as_str() != scope);
    }

    /// Drop every subscription `scope` takes part in, as subscriber or as
    /// target (it was destroyed).
    pub(crate) fn drop_involving(&mut self, scope: &str) {
        self.entries
            .retain(|s| s.subscriber.as_str() != scope && &*s.target != scope);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hosted::names::ActionSet;
    use crate::hosted::registry::{Grants, ModuleGrants};
    use crate::module_host::ModuleInstanceId;

    fn watcher(reads: &[&str]) -> (ScopeName, HostedModule) {
        let scope = ScopeName::parse("w").unwrap();
        let module = HostedModule {
            id: ModuleInstanceId(0),
            actions: ActionSet::parse(&scope, vec!["changed".into(), "other".into()]).unwrap(),
            grants: Grants::from(ModuleGrants::new(reads.iter().copied(), [""; 0])),
            wiring: Default::default(),
        };
        (scope, module)
    }

    fn request(target: &str, path: &str, on_change: &str) -> SubscribeRequest {
        SubscribeRequest {
            target: target.into(),
            path: path.into(),
            on_change: on_change.into(),
        }
    }

    #[test]
    fn a_subscription_needs_the_reads_grant_and_an_own_action() {
        let (scope, module) = watcher(&["t"]);
        let mut subs = Subscriptions::default();

        let denied = subs
            .add(&scope, &module, request("u", "n", "changed"))
            .unwrap_err();
        assert!(
            matches!(&denied.cause, FailureCause::ReadDenied { missing_grant } if missing_grant == "u")
        );
        assert_eq!(
            denied.origin,
            Origin::SubscribeRequest {
                target: "u".into(),
                path: "n".into()
            }
        );

        let foreign = subs
            .add(&scope, &module, request("t", "n", "t:bump"))
            .unwrap_err();
        assert!(matches!(foreign.cause, FailureCause::NotAccepted));
        assert_eq!(
            (foreign.scope.as_str(), foreign.action.as_str()),
            ("w", "t:bump")
        );
        assert!(subs.is_empty());

        // The target compares case-insensitively.
        subs.add(&scope, &module, request("T", "n", "changed"))
            .unwrap();
        assert!(subs.has_watchers("t") && !subs.has_watchers("T"));
    }

    #[test]
    fn re_subscribing_replaces_and_the_per_module_limit_holds() {
        let (scope, module) = watcher(&["t"]);
        let mut subs = Subscriptions::default();
        subs.add(&scope, &module, request("t", "n", "changed"))
            .unwrap();
        subs.add(&scope, &module, request("t", "n", "other"))
            .unwrap();
        assert_eq!(subs.len(), 1);
        let owed = subs.notifications_for("t", &["n.deep".to_string()]);
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].on_change, "other");

        for i in 1..MAX_SUBSCRIPTIONS_PER_MODULE {
            subs.add(&scope, &module, request("t", &format!("p{i}"), "changed"))
                .unwrap();
        }
        let full = subs
            .add(&scope, &module, request("t", "one-more", "changed"))
            .unwrap_err();
        assert!(matches!(
            full.cause,
            FailureCause::SubscriptionLimit {
                limit: MAX_SUBSCRIPTIONS_PER_MODULE
            }
        ));
        // A held path can still be replaced at the limit.
        subs.add(&scope, &module, request("t", "n", "changed"))
            .unwrap();
        assert_eq!(subs.len(), MAX_SUBSCRIPTIONS_PER_MODULE);
    }

    #[test]
    fn only_overlapping_paths_of_the_changed_target_notify() {
        let (scope, module) = watcher(&["t", "u"]);
        let mut subs = Subscriptions::default();
        subs.add(&scope, &module, request("t", "user.name", "changed"))
            .unwrap();
        subs.add(&scope, &module, request("t", "", "other"))
            .unwrap();
        subs.add(&scope, &module, request("u", "user", "changed"))
            .unwrap();

        let actions = |target: &str, changed: &[&str]| -> Vec<String> {
            let changed: Vec<String> = changed.iter().map(|p| p.to_string()).collect();
            subs.notifications_for(target, &changed)
                .into_iter()
                .map(|n| format!("{}@{}", n.on_change, n.path))
                .collect()
        };
        assert_eq!(actions("t", &["user"]), ["changed@user.name", "other@"]);
        assert_eq!(actions("t", &["users"]), ["other@"]);
        assert_eq!(actions("u", &["user.name"]), ["changed@user"]);
        assert!(actions("t", &[]).is_empty());
    }

    #[test]
    fn teardown_drops_by_direction() {
        let (w, module) = watcher(&["t", "w"]);
        let mut subs = Subscriptions::default();
        subs.add(&w, &module, request("t", "", "changed")).unwrap();
        subs.add(&w, &module, request("w", "", "changed")).unwrap();

        let mut rewired = Subscriptions::default();
        rewired
            .add(&w, &module, request("t", "", "changed"))
            .unwrap();
        rewired.drop_made_by("t");
        assert_eq!(rewired.len(), 1, "t made none; w's subscription on t stays");
        rewired.drop_made_by("w");
        assert!(rewired.is_empty());

        subs.drop_involving("t");
        assert_eq!(subs.len(), 1, "w's subscription on itself is untouched");
        subs.drop_involving("w");
        assert!(subs.is_empty());
    }
}

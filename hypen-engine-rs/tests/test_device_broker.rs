//! Device broker (RFC 001) — ids, settlement, owners and sweeps, activation
//! authority, background pin caps, leases on a fake clock (fixed 5 s
//! cadence), violations and their reactions, the `core.capabilities`
//! stream, JSON streams with event credit and token buckets, streamed
//! uploads, determinism. Ported from the TS broker suites
//! (device-broker, device-lifetime, device-srv-lease, device-srv-stream,
//! device-srv-control-stream, device-srv-validation) onto the sans-IO API.

mod device_broker_support;

use device_broker_support::*;
use hypen_engine::device::{
    negotiate, server_advertisement, BrokerConfig, DeviceBroker, EventRate, OpenSpec, Outcome,
    Output, RevisionOverride, ViolationRate, DEFAULT_STREAM_INITIAL_CREDIT,
    DEFAULT_UPLOAD_INITIAL_CREDIT, DEVICE_PLANE_CLOSE_CODE, LEASE_MAX_UNACKED_RENEWALS,
};
use hypen_engine::serialize::device::{
    find_revision, select_device_ack, CapabilitySelection, DeviceAck, DeviceErrorCode as E,
    DeviceHello, Lifetime, Mode,
};
use serde_json::{json, Value};

fn sp(capability: &str, params: Value) -> OpenSpec {
    OpenSpec::new(capability, params, "m1", 1)
}

// ---------------------------------------------------------------------------
// ids and settlement
// ---------------------------------------------------------------------------

#[test]
fn ids_are_monotone_from_one_and_never_reused() {
    let mut h = H::new();
    assert_eq!(h.core, 1, "core.capabilities is the first request");
    let a = h.gallery(65536);
    let b = h.gallery(65536);
    assert_eq!((a, b), (2, 3));
    h.text(result(a, json!({"items": []})));
    assert!(h.settled(a).unwrap().is_ok());
    let c = h.gallery(65536);
    assert_eq!(c, 4, "a completed id is never reused");
    let ids: Vec<u64> = h
        .texts()
        .iter()
        .filter(|m| m["type"] == "deviceRequest")
        .map(|m| m["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, vec![1, 2, 3, 4]);
}

#[test]
fn the_id_space_is_bounded_and_exhaustion_resets_the_connection() {
    let mut cfg = config();
    cfg.request_id_limit = 3;
    let mut h = H::with(cfg);
    assert_eq!(h.permission(), 2);
    let refused = h
        .open(h.spec("permission.request", json!({"permission": "camera"})))
        .unwrap_err();
    assert_eq!(refused.code, E::ConnectionLost);
    let (code, reason) = h.closed().expect("device plane closed");
    assert_eq!(code, DEVICE_PLANE_CLOSE_CODE);
    assert!(reason.contains("request id space exhausted"), "{reason}");
    assert_eq!(
        h.code(2),
        Some(E::ConnectionLost),
        "live work fails with the connection"
    );
}

#[test]
fn a_result_settles_exactly_once_and_later_messages_are_ignored() {
    let mut h = H::new();
    let id = h.permission();
    assert!(h.text(result(id, json!({"status": "granted"}))));
    assert_eq!(
        h.settled(id),
        Some(&Outcome::Ok {
            result: json!({"status": "granted"}),
            blobs: vec![],
            simulated: false,
            held: false
        })
    );
    assert!(
        !h.text(error(id, "denied")),
        "a second terminal is for a retired id"
    );
    assert_eq!(h.settle_count(id), 1);
    assert_eq!(h.b.live_count(), 1, "only core.capabilities stays live");
}

#[test]
fn an_error_settles_with_its_code_and_detail_and_sends_nothing() {
    let mut h = H::new();
    let id = h.gallery(65536);
    let before = h.texts().len();
    h.text(json!({"type": "deviceResponse", "id": id, "error": {"code": "denied", "platformDetail": "user-declined"}}));
    assert_eq!(
        h.settled(id),
        Some(&Outcome::Err {
            code: E::Denied,
            detail: Some("user-declined".into())
        })
    );
    assert_eq!(
        h.texts().len(),
        before,
        "the server never answers a client terminal"
    );
}

#[test]
fn simulated_results_are_surfaced() {
    let mut h = H::new();
    let id = h.permission();
    h.text(json!({"type": "deviceResponse", "id": id, "result": {"status": "prompt"}, "simulated": true}));
    assert!(matches!(
        h.settled(id),
        Some(Outcome::Ok {
            simulated: true,
            ..
        })
    ));
}

#[test]
fn unknown_and_retired_ids_are_ignored_in_any_direction() {
    let mut h = H::new();
    let before = h.log.len();
    for m in [
        result(999, json!({})),
        control(999, json!({"leaseAck": 1})),
        control(999, json!({"cancel": true})),
        control(999, json!({"renewLease": 1})),
        json!({"type": "deviceEvent", "id": 999, "control": {"cancel": false}}),
        json!({"type": "deviceResponse", "id": 999, "result": {}, "error": {"code": "denied"}}),
    ] {
        assert!(!h.text(m));
    }
    assert!(!h.frame(999, 0, 0, b"abc"));
    assert_eq!(h.log.len(), before, "nothing sent, nothing settled");
    assert_eq!(h.b.connection_violations(), 0, "never a violation");
}

#[test]
fn server_cancel_retires_the_id_and_settles_cancelled() {
    let mut h = H::new();
    let id = h.gallery(65536);
    h.b.cancel(id, h.now);
    h.drain();
    assert_eq!(h.cancels(id), 1);
    assert_eq!(h.code(id), Some(E::Cancelled));
    assert!(
        !h.text(result(id, json!({"items": []}))),
        "late success ignored"
    );
    h.b.cancel(id, h.now);
    h.drain();
    assert_eq!(h.cancels(id), 1, "cancel is idempotent");
}

#[test]
fn close_rejects_live_work_locally_and_sends_nothing() {
    let mut h = H::new();
    let a = h.gallery(65536);
    let b = h.permission();
    let texts = h.texts().len();
    h.b.close(E::ConnectionLost);
    h.drain();
    assert_eq!(h.code(a), Some(E::ConnectionLost));
    assert_eq!(h.code(b), Some(E::ConnectionLost));
    assert_eq!(h.texts().len(), texts, "no cancellation after socket loss");
    assert_eq!(h.b.live_count(), 0);
    assert!(
        h.closed().is_none(),
        "a host close is not a broker-initiated reset"
    );
    assert!(h
        .open(h.spec("permission.request", json!({"permission": "camera"})))
        .is_err());
    assert_eq!(h.b.next_deadline(), None);
}

// ---------------------------------------------------------------------------
// owners, activation authority, sweeps, background pin caps
// ---------------------------------------------------------------------------

#[test]
fn deactivation_sweeps_that_activation_only() {
    let mut h = H::new();
    assert!(h.b.owner_activated("m2", 1, 0));
    let a = h.gallery(65536);
    let b = h
        .open(OpenSpec::new("gallery.pick", gallery_params(1), "m2", 1))
        .unwrap();
    h.b.owner_deactivated("m1", 1, h.now);
    h.drain();
    assert_eq!(h.code(a), Some(E::Cancelled));
    assert_eq!(h.cancels(a), 1);
    assert!(h.b.is_live(b), "another module's work survives");
    let refused = h.open(h.spec("permission.request", json!({"permission": "camera"})));
    assert_eq!(
        refused.unwrap_err().detail.as_deref(),
        Some("owner-inactive")
    );
}

#[test]
fn activation_authority_is_strictly_increasing_and_moves_with_activation() {
    let mut h = H::new();
    let old = h.permission();
    assert!(!h.b.owner_activated("m1", 1, 0), "same activation again");
    assert!(h.b.owner_activated("m1", 2, 0));
    h.drain();
    assert_eq!(
        h.code(old),
        Some(E::Cancelled),
        "the previous activation's work ends"
    );
    let stale = h.open(OpenSpec::new(
        "permission.query",
        json!({"permission": "camera"}),
        "m1",
        1,
    ));
    assert_eq!(stale.unwrap_err().code, E::Unavailable);
    assert!(!h.b.owner_activated("m1", 1, 0), "never backwards");
    assert!(h
        .open(OpenSpec::new(
            "permission.query",
            json!({"permission": "camera"}),
            "m1",
            2
        ))
        .is_ok());
    h.b.owner_destroyed("m1", h.now);
    h.drain();
    assert!(
        !h.b.owner_activated("m1", 3, 0),
        "a destroyed instance never comes back"
    );
    assert!(!h.b.owner_activated("", 1, 0));
    assert!(!h.b.owner_activated("m9", 0, 0));
}

#[test]
fn background_is_refused_by_the_real_v1_registry() {
    let mut h = H::new();
    for (cap, params) in [
        ("gallery.pick", gallery_params(1)),
        (
            "mic.record",
            json!({"sampleRate": 48000, "format": "pcm16"}),
        ),
    ] {
        let mut spec = h.spec(cap, params);
        spec.lifetime = Some(Lifetime::Background);
        let err = h.open(spec).unwrap_err();
        assert_eq!(err.code, E::Unsupported);
        assert_eq!(
            err.detail.as_deref(),
            Some(format!("lifetime \"background\" is not allowed by {cap} v1").as_str())
        );
    }
    let mut spec = h.spec("gallery.pick", gallery_params(1));
    spec.lifetime = Some(Lifetime::Connection);
    let err = h.open(spec).unwrap_err();
    assert_eq!(err.code, E::Unsupported, "connection is protocol-internal");
    assert!(h.requests("gallery.pick").is_empty());
}

fn background_config() -> BrokerConfig {
    const BOTH: &[Lifetime] = &[Lifetime::Activation, Lifetime::Background];
    let mut rev = *find_revision("gallery.pick", 1).unwrap();
    rev.lifetimes = BOTH;
    let mut cfg = config();
    cfg.revision_overrides.push(RevisionOverride {
        capability: "gallery.pick".into(),
        revision: rev,
    });
    cfg
}

fn background(h: &mut H, module: &str) -> Result<u32, hypen_engine::device::LocalRefusal> {
    let mut spec = OpenSpec::new("gallery.pick", gallery_params(1), module, 1);
    spec.lifetime = Some(Lifetime::Background);
    h.open(spec)
}

#[test]
fn background_work_survives_deactivation_and_is_swept_on_destroy() {
    let mut h = H::with(background_config());
    let bg = background(&mut h, "m1").unwrap();
    let fg = h.gallery(65536);
    let req = h.requests("gallery.pick")[0].clone();
    assert_eq!(req["lifetime"], "background");
    assert_eq!(req["owner"], json!({"moduleInstanceId": "m1"}));
    assert!(h.b.has_background_work("m1"));

    h.b.owner_deactivated("m1", 1, h.now);
    h.drain();
    assert_eq!(h.code(fg), Some(E::Cancelled), "activation work is swept");
    assert!(h.b.is_live(bg), "background work survives deactivation");
    assert_eq!(h.cancels(bg), 0);

    h.b.owner_destroyed("m1", h.now);
    h.drain();
    assert_eq!(h.code(bg), Some(E::Cancelled));
    assert_eq!(h.cancels(bg), 1);
    assert!(!h.b.has_background_work("m1"));
}

#[test]
fn background_pins_are_capped_per_connection() {
    let mut h = H::with(background_config());
    for m in ["m2", "m3"] {
        assert!(h.b.owner_activated(m, 1, 0));
    }
    let a = background(&mut h, "m1").unwrap();
    background(&mut h, "m2").unwrap();
    assert!(
        background(&mut h, "m1").is_ok(),
        "a pinned module may add work"
    );
    let err = background(&mut h, "m3").unwrap_err();
    assert_eq!(err.code, E::Throttled);
    assert_eq!(
        err.detail.as_deref(),
        Some("background pin cap reached (2 modules)")
    );
    assert!(!h.b.admits_background("m3"));
    assert_eq!(h.b.background_owners().len(), 2);

    // Ending one module's background work frees its pin.
    h.b.cancel(a, h.now);
    h.b.owner_destroyed("m1", h.now);
    h.drain();
    assert!(h.b.admits_background("m3"));
    assert!(background(&mut h, "m3").is_ok());
}

// ---------------------------------------------------------------------------
// admission against the selected revision
// ---------------------------------------------------------------------------

#[test]
fn admission_clamps_and_defaults_against_the_revision() {
    let mut h = H::new();
    let mut spec = h.spec("gallery.pick", gallery_params(1));
    spec.initial_credit = Some(64 * MIB as u64);
    spec.timeout_ms = Some(10_000_000);
    let id = h.open(spec).unwrap();
    let req = h.requests("gallery.pick")[0].clone();
    assert_eq!(req["id"], id);
    assert_eq!(
        req["initialCredit"],
        4 * MIB,
        "clamped to max_initial_credit"
    );
    assert_eq!(req["timeoutMs"], 300_000, "clamped to max_timeout_ms");

    let up = h.open(h.spec("gallery.pick", gallery_params(1))).unwrap();
    assert_eq!(
        h.b.outstanding_credit(up),
        Some(DEFAULT_UPLOAD_INITIAL_CREDIT)
    );
    let scan = h.open(h.spec("bluetooth.scan", json!({}))).unwrap();
    assert_eq!(
        h.b.outstanding_event_credit(scan),
        Some(DEFAULT_STREAM_INITIAL_CREDIT)
    );
    let mut perm = h.spec("permission.query", json!({"permission": "camera"}));
    perm.initial_credit = Some(99);
    h.open(perm).unwrap();
    assert_eq!(
        h.requests("permission.query")[0]["initialCredit"],
        0,
        "no data plane: zero"
    );
}

#[test]
fn admission_refusals_send_nothing() {
    let mut h = H::new();
    let before = h.texts().len();
    let refuse = |h: &mut H, spec: OpenSpec| h.open(spec).unwrap_err();

    let e = refuse(&mut h, sp("teleport", json!({})));
    assert_eq!((e.code, e.detail), (E::Unsupported, None));
    let mut s = h.spec("gallery.pick", gallery_params(1));
    s.version = Some(2);
    assert_eq!(refuse(&mut h, s).code, E::Unsupported);
    let e = refuse(
        &mut h,
        sp("permission.query", json!({"permission": "camra"})),
    );
    assert_eq!(e.code, E::InvalidParams, "params validated before sending");
    let mut s = h.spec("gallery.pick", gallery_params(1));
    s.initial_credit = Some(0);
    let e = refuse(&mut h, s);
    assert_eq!(e.code, E::InvalidParams);
    assert!(e.detail.unwrap().contains("initialCredit must be ≥ 1"));
    let mut s = h.spec("bluetooth.scan", json!({}));
    s.initial_credit = Some(0);
    assert_eq!(refuse(&mut h, s).code, E::InvalidParams);
    let mut s = h.spec(
        "mic.record",
        json!({"sampleRate": 16000, "format": "pcm16"}),
    );
    s.mode = Some(Mode::Unary);
    let e = refuse(&mut h, s);
    assert_eq!(
        e.detail.as_deref(),
        Some("mic.record is a stream; use stream()")
    );
    let mut s = h.spec("gallery.pick", gallery_params(1));
    s.mode = Some(Mode::Stream);
    let e = refuse(&mut h, s);
    assert_eq!(
        e.detail.as_deref(),
        Some("gallery.pick is not a stream; use request()")
    );
    let e = refuse(&mut h, sp("core.capabilities", json!({})));
    assert_eq!(
        e.code,
        E::Unsupported,
        "app code cannot open the control stream"
    );
    let e = refuse(
        &mut h,
        OpenSpec::new(
            "permission.query",
            json!({"permission": "camera"}),
            "ghost",
            1,
        ),
    );
    assert_eq!(e.detail.as_deref(), Some("owner-inactive"));
    assert_eq!(h.texts().len(), before);
}

#[test]
fn the_replay_firewall_refuses_before_anything_is_sent() {
    let mut h = H::new();
    let before = h.texts().len();
    let mut spec = sp("gallery.pick", gallery_params(1));
    spec.replayed = true;
    let e = h.open(spec).unwrap_err();
    assert_eq!(
        (e.code, e.detail.as_deref()),
        (E::Unavailable, Some("syncActions.replay"))
    );
    // Even for names that would otherwise be refused differently.
    let mut spec = sp("teleport", json!({}));
    spec.replayed = true;
    assert_eq!(
        h.open(spec).unwrap_err().detail.as_deref(),
        Some("syncActions.replay")
    );
    assert_eq!(h.texts().len(), before);
    assert!(
        h.open(sp("gallery.pick", gallery_params(1))).is_ok(),
        "origin dispatches work"
    );
}

#[test]
fn the_plane_must_be_started_once() {
    let mut b = DeviceBroker::new(config(), 0);
    assert!(b.owner_activated("m1", 1, 0));
    let e = b
        .open(
            OpenSpec::new("permission.query", json!({"permission": "camera"}), "m1", 1),
            0,
        )
        .unwrap_err();
    assert_eq!(e.detail.as_deref(), Some("device plane not started"));
    assert!(b.poll().is_empty());
    let core = b.start(0).unwrap();
    assert!(b.start(0).is_err());
    let out = b.poll();
    let first: Value = match &out[0] {
        Output::SendText(t) => serde_json::from_str(t).unwrap(),
        o => panic!("{o:?}"),
    };
    assert_eq!(
        first,
        json!({"type": "deviceRequest", "id": core, "capability": "core.capabilities", "version": 1,
               "owner": {"connection": true}, "lifetime": "connection", "timeoutMs": 86_400_000,
               "initialCredit": 8, "params": {}})
    );
    // An ack without core.capabilities never starts.
    let mut ack = full_ack();
    ack.capabilities.retain(|c| c.name != "core.capabilities");
    let mut b = DeviceBroker::new(BrokerConfig::new(ack), 0);
    assert_eq!(b.start(0).unwrap_err().code, E::Unsupported);
}

#[test]
fn a_json_only_connection_never_selects_binary_planes() {
    let mut ack = full_ack();
    ack.binary = false;
    let mut h = H::with(BrokerConfig::new(ack));
    assert!(!h.b.supports("gallery.pick"));
    assert!(!h.b.supports("file.save"));
    assert!(h.b.supports("permission.query"));
    assert_eq!(
        h.open(h.spec("gallery.pick", gallery_params(1)))
            .unwrap_err()
            .code,
        E::Unsupported
    );
}

#[test]
fn negotiation_uses_the_server_advertisement() {
    let adv = server_advertisement();
    assert_eq!(
        adv.len(),
        hypen_engine::serialize::device::registry().len(),
        "every v1 revision has a consumer"
    );
    let hello: DeviceHello = DeviceHello::from_value(&json!({
        "protocolVersions": [1], "binary": true,
        "capabilities": [{"name": "core.capabilities", "versions": [1]}, {"name": "gallery.pick", "versions": [1]},
                         {"name": "mic.record", "versions": [1]}, {"name": "teleport", "versions": [1]}]
    }))
    .unwrap();
    let ack = negotiate(&hello, true).unwrap();
    assert_eq!(ack, select_device_ack(&hello, &[1], &adv, true).unwrap());
    let names: Vec<&str> = ack.capabilities.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"mic.record") && !names.contains(&"teleport"));
    let json_only = negotiate(&hello, false).unwrap();
    assert!(!json_only.binary);
    assert!(json_only
        .capabilities
        .iter()
        .all(|c| c.name == "core.capabilities"));
}

// ---------------------------------------------------------------------------
// leases (fixed 5 s cadence, 15 s expiry, bounded window, u32 sequences)
// ---------------------------------------------------------------------------

#[test]
fn renew_lease_one_goes_out_with_the_request_and_acks_keep_it_live() {
    let mut h = H::new();
    let id = h.gallery(65536);
    assert_eq!(
        h.renewals(id),
        vec![(1, 0)],
        "seq 1 immediately after the request"
    );
    let texts = h.texts();
    let req_idx = texts
        .iter()
        .position(|m| m["id"] == id && m["type"] == "deviceRequest")
        .unwrap();
    assert_eq!(
        texts[req_idx + 1]["control"]["renewLease"],
        1,
        "right after its request"
    );
    for _ in 0..40 {
        for (seq, _) in h.renewals(id) {
            h.text(control(id, json!({"leaseAck": seq})));
        }
        h.advance(1000);
    }
    assert!(h.b.is_live(id));
    assert!(h.renewals(id).len() >= 8);
    h.advance(16_000);
    assert_eq!(
        h.code(id),
        Some(E::ConnectionLost),
        "silence past 15 s expires"
    );
    assert_eq!(h.cancels(id), 1);
}

/// A client that acks each renewal of `id` after `rtt` ms; `ack` filters.
fn acking_client(h: &mut H, id: u32, rtt: u64, total: u64, ack: impl Fn(u64) -> bool) {
    let mut pending: Vec<(u64, u64)> = Vec::new();
    let mut seen = 0usize;
    let mut t = 0;
    while t < total {
        h.advance(10);
        t += 10;
        let renewals = h.renewals(id);
        for &(seq, at) in &renewals[seen..] {
            if ack(seq) {
                pending.push((seq, at + rtt));
            }
        }
        seen = renewals.len();
        let due: Vec<(u64, u64)> = pending
            .iter()
            .copied()
            .filter(|(_, d)| *d <= h.now)
            .collect();
        pending.retain(|(_, d)| *d > h.now);
        for (seq, _) in due {
            h.text(control(id, json!({"leaseAck": seq})));
        }
    }
}

#[test]
fn renewals_keep_a_fixed_five_second_cadence_with_50ms_rtt() {
    let mut h = H::new();
    let id = h.permission();
    acking_client(&mut h, id, 50, 20_000, |_| true);
    assert_eq!(
        h.renewals(id),
        vec![(1, 0), (2, 5_000), (3, 10_000), (4, 15_000), (5, 20_000)],
        "keyed to the renewal send, not the ack arrival"
    );
    assert!(h.b.is_live(id));
}

#[test]
fn a_four_second_rtt_still_gets_a_renewal_every_five_seconds() {
    let mut h = H::new();
    let id = h.permission();
    acking_client(&mut h, id, 4_000, 60_000, |_| true);
    let at: Vec<u64> = h.renewals(id).iter().map(|(_, at)| *at).collect();
    assert!(at.windows(2).all(|w| w[1] - w[0] == 5_000), "{at:?}");
    assert!(h.b.is_live(id));
}

#[test]
fn without_acks_expiry_is_checked_before_the_fifteen_second_renewal() {
    let mut h = H::new();
    let id = h.permission();
    acking_client(&mut h, id, 50, 20_000, |_| false);
    let seqs: Vec<u64> = h.renewals(id).iter().map(|(s, _)| *s).collect();
    assert_eq!(seqs, vec![1, 2, 3], "no seq 4 to a lost peer");
    assert_eq!(h.code(id), Some(E::ConnectionLost));
}

#[test]
fn fifteen_seconds_without_ack_progress_expire_while_renewals_flow() {
    let mut h = H::new();
    let id = h.permission();
    acking_client(&mut h, id, 50, 14_000, |seq| seq == 1);
    assert!(h.b.is_live(id));
    acking_client(&mut h, id, 50, 3_000, |seq| seq == 1);
    assert_eq!(h.code(id), Some(E::ConnectionLost));
}

#[test]
fn the_unacknowledged_renewal_window_is_bounded() {
    let mut h = H::new();
    let id = h.permission();
    // Renewals at 0/5/10 s; the client's acks progress but lag behind.
    h.advance(12_000);
    h.text(control(id, json!({"leaseAck": 1})));
    h.advance(13_500); // t = 25.5 s
    let seqs = |h: &H| -> Vec<u64> { h.renewals(id).iter().map(|(s, _)| *s).collect() };
    // 15 s: 4 - 1 = 3 outstanding → sent; 20 s: 3 again (seq 5 sent);
    // 25 s: 5 - 1 = 4 > 3 → the window holds the renewal back.
    assert_eq!(seqs(&h), vec![1, 2, 3, 4, 5]);
    assert_eq!(u64::from(LEASE_MAX_UNACKED_RENEWALS), 3);
    assert!(
        h.b.is_live(id),
        "liveness is the 15 s no-progress rule's call"
    );
    h.text(control(id, json!({"leaseAck": 2})));
    h.advance(4_500); // t = 30 s: 5 - 2 = 3 → renewing resumes
    assert_eq!(seqs(&h), vec![1, 2, 3, 4, 5, 6]);
    assert_eq!(
        h.renewals(id).last().unwrap().1,
        30_000,
        "on the fixed cadence"
    );
}

#[test]
fn a_fabricated_or_future_ack_is_invalid_params_and_cancel() {
    let mut h = H::new();
    let id = h.gallery(65536);
    h.text(control(id, json!({"leaseAck": 999})));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert!(h.detail(id).contains("never sent"));
    assert_eq!(h.cancels(id), 1);
}

#[test]
fn repeated_and_older_acks_do_not_refresh_liveness() {
    let mut h = H::new();
    let id = h.gallery(65536);
    h.text(control(id, json!({"leaseAck": 1})));
    for _ in 0..16 {
        h.advance(1000);
        h.text(control(id, json!({"leaseAck": 1})));
    }
    assert_eq!(h.code(id), Some(E::ConnectionLost));
}

#[test]
fn a_queued_ack_after_expiry_does_not_revive_the_request() {
    let mut h = H::new();
    let id = h.permission();
    // Time passes without a tick (a host timer running late), then an ack.
    h.now += 15_000;
    h.text(control(id, json!({"leaseAck": 1})));
    assert_eq!(
        h.code(id),
        Some(E::ConnectionLost),
        "expiry is checked before the ack"
    );
}

#[test]
fn the_overall_deadline_cancels_timeout() {
    let mut h = H::new();
    let mut spec = h.spec("permission.query", json!({"permission": "camera"}));
    spec.timeout_ms = Some(1_000);
    let id = h.open(spec).unwrap();
    h.advance(999);
    assert!(h.b.is_live(id));
    h.advance(1);
    assert_eq!(h.code(id), Some(E::Timeout));
    assert_eq!(h.cancels(id), 1);
}

// ---------------------------------------------------------------------------
// violations and reactions (decision D8)
// ---------------------------------------------------------------------------

#[test]
fn wrong_direction_messages_on_live_ids_terminate_them() {
    for (m, why) in [
        (json!({"cancel": true}), "cancel"),
        (json!({"renewLease": 1}), "renewLease"),
    ] {
        let mut h = H::new();
        let id = h.permission();
        h.text(control(id, m));
        assert_eq!(h.code(id), Some(E::InvalidParams));
        assert!(h.detail(id).contains(why));
        assert_eq!(h.cancels(id), 1);
    }
    let mut h = H::new();
    let id = h.permission();
    let req = h.requests("permission.request")[0].clone();
    h.text(req);
    assert_eq!(h.detail(id), "deviceRequest from the client");
    assert_eq!(h.cancels(id), 1);
}

#[test]
fn malformed_known_id_messages_terminate_that_request() {
    // A response carrying both result and error: the client's terminal,
    // settled locally without a cancel.
    let mut h = H::new();
    let id = h.permission();
    h.text(json!({"type": "deviceResponse", "id": id, "result": {"status": "granted"}, "error": {"code": "denied"}}));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert_eq!(h.cancels(id), 0);
    // simulated must be exactly true; a non-object result; neither member.
    for bad in [
        json!({"type": "deviceResponse", "id": 2, "result": {"status": "granted"}, "simulated": false}),
        json!({"type": "deviceResponse", "id": 2, "result": [1]}),
        json!({"type": "deviceResponse", "id": 2}),
    ] {
        let mut h = H::new();
        let id = h.permission();
        assert_eq!(id, 2);
        h.text(bad);
        assert_eq!(h.code(id), Some(E::InvalidParams));
        assert_eq!(h.cancels(id), 0);
    }
    // Multi-variant control, wrong control type, event AND control: a cancel.
    for bad in [
        json!({"type": "deviceEvent", "id": 2, "control": {"leaseAck": 1, "grant": 5}}),
        json!({"type": "deviceEvent", "id": 2, "control": {"grant": "5"}}),
        json!({"type": "deviceEvent", "id": 2, "control": {"paused": true}, "event": {"kind": "progress", "state": "running"}}),
    ] {
        let mut h = H::new();
        let id = h.permission();
        h.text(bad);
        assert_eq!(h.code(id), Some(E::InvalidParams));
        assert_eq!(h.cancels(id), 1);
    }
}

#[test]
fn a_result_violating_the_revision_schema_never_reaches_the_handler() {
    let mut h = H::new();
    let id = h.permission();
    h.text(result(id, json!({"status": "maybe"})));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert!(h.detail(id).starts_with("result"));
    assert_eq!(h.cancels(id), 0);
}

#[test]
fn json_limit_breaches_are_connection_level_and_touch_no_request() {
    let mut h = H::new();
    let id = h.permission();
    let raw = [
        format!(
            r#"{{"type":"deviceResponse","id":{id},"id":{id},"result":{{"status":"granted"}}}}"#
        ),
        format!(
            r#"{{"type":"deviceResponse","id":{id},"id":{id},"result":{{"status":"granted"}}}}"#
        ),
        format!(
            r#"{{"type":"deviceEvent","id":{id},"event":{{"kind":"progress","state":"running","n":1.0}}}}"#
        ),
        "not json".to_string(),
        r#"{"type":"deviceEvent"}"#.to_string(),
    ];
    for (i, text) in raw.iter().enumerate() {
        assert!(!h.raw(text));
        assert_eq!(h.b.connection_violations(), i as u64 + 1);
    }
    assert!(h.b.last_connection_violation().is_some());
    assert!(h.b.is_live(id), "the request its id seems to name lives on");
    assert_eq!(h.cancels(id), 0);
    h.text(result(id, json!({"status": "granted"})));
    assert!(h.settled(id).unwrap().is_ok());
}

#[test]
fn over_one_mib_device_text_is_dropped_before_parsing() {
    let mut h = H::new();
    let id = h.permission();
    let big = format!(
        r#"{{"type":"deviceEvent","id":{id},"event":{{"kind":"progress","state":"running","pad":"{}"}}}}"#,
        "x".repeat(MIB)
    );
    assert!(hypen_engine::device::is_oversize_device_text(&big));
    assert!(!h.raw(&big));
    assert_eq!(h.b.connection_violations(), 1);
    assert!(h.b.is_live(id));
}

#[test]
fn hosts_report_violations_they_detect_before_parsing() {
    let mut cfg = config();
    cfg.violation_rate = ViolationRate {
        burst: 1.0,
        per_second: 0.0,
    };
    let mut h = H::with(cfg);
    let id = h.permission();
    h.b.report_connection_violation("device message over 1 MiB", h.now);
    h.drain();
    assert_eq!(h.b.connection_violations(), 1);
    assert_eq!(
        h.b.last_connection_violation(),
        Some("device message over 1 MiB")
    );
    assert!(h.b.is_live(id) && h.closed().is_none());
    h.b.report_connection_violation("device message over 1 MiB", h.now);
    h.drain();
    assert_eq!(h.closed().unwrap().0, 1012);
    assert!(h.b.is_binary());
}

#[test]
fn repeated_connection_level_violations_close_the_plane() {
    let mut cfg = config();
    cfg.violation_rate = ViolationRate {
        burst: 3.0,
        per_second: 0.0,
    };
    let mut h = H::with(cfg);
    let id = h.permission();
    for _ in 0..3 {
        h.raw(r#"{"type":"deviceEvent","id":1,"id":1}"#);
    }
    assert!(h.closed().is_none());
    h.raw(r#"{"type":"deviceEvent","id":1,"id":1}"#);
    let (code, reason) = h.closed().expect("closed");
    assert_eq!(code, 1012);
    assert!(reason.contains("repeated protocol violations"));
    assert_eq!(h.code(id), Some(E::ConnectionLost));
    assert!(
        !h.text(result(id, json!({"status": "granted"}))),
        "nothing after close"
    );
    assert_eq!(h.b.connection_violations(), 4);
}

#[test]
fn the_violation_bucket_refills_with_time() {
    let mut cfg = config();
    cfg.violation_rate = ViolationRate {
        burst: 2.0,
        per_second: 1.0,
    };
    let mut h = H::with(cfg);
    for _ in 0..10 {
        h.raw("{}");
        h.advance(1_000);
    }
    assert!(h.closed().is_none(), "one per second is tolerated");
    h.raw("{}");
    h.raw("{}");
    h.raw("{}");
    assert!(h.closed().is_some());
}

// ---------------------------------------------------------------------------
// core.capabilities
// ---------------------------------------------------------------------------

#[test]
fn a_replacement_snapshot_replaces_the_live_selection() {
    let mut h = H::new();
    assert!(h.b.supports("gallery.pick"));
    h.snapshot(&["core.capabilities"]);
    assert!(!h.b.supports("gallery.pick"));
    let e = h
        .open(h.spec("gallery.pick", gallery_params(1)))
        .unwrap_err();
    assert_eq!((e.code, e.detail), (E::Unsupported, None));
    h.snapshot(&["core.capabilities", "gallery.pick"]);
    assert!(h.b.supports("gallery.pick"));
    assert!(h.closed().is_none());
}

#[test]
fn a_snapshot_selects_only_what_the_server_advertises() {
    let mut h = H::new();
    h.snapshot(&["core.capabilities", "camera.capture", "teleport"]);
    let names: Vec<&str> = h.b.selection().iter().map(|(n, _)| n.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(sorted, vec!["camera.capture", "core.capabilities"]);
}

/// The negotiated ack is the ceiling for the whole connection (§2.2): a
/// snapshot narrows the live selection or restores an entry it withdrew,
/// never widens it — even to a capability this server advertises. Every
/// client refuses a request outside its ack with `unsupported`, so the
/// broker must refuse it locally too, and `supports()` must say so.
#[test]
fn a_snapshot_never_widens_the_live_selection_beyond_the_ack() {
    let ack = DeviceAck {
        protocol_version: 1,
        binary: true,
        capabilities: ["core.capabilities", "gallery.pick", "permission.query"]
            .iter()
            .map(|n| CapabilitySelection {
                name: n.to_string(),
                version: 1,
            })
            .collect(),
    };
    let mut h = H::with(BrokerConfig::new(ack));
    assert!(
        server_advertisement()
            .iter()
            .any(|o| o.name == "mic.record"),
        "the server advertises mic.record"
    );
    assert!(!h.b.supports("mic.record"));
    // The client's recording indicator became ready after the hello.
    h.snapshot(&[
        "core.capabilities",
        "gallery.pick",
        "mic.record",
        "bluetooth.scan",
        "permission.query",
    ]);
    assert!(h.closed().is_none());
    assert!(!h.b.supports("mic.record"), "outside the ack");
    assert!(!h.b.supports("bluetooth.scan"), "outside the ack");
    assert_eq!(h.b.selected_version("mic.record"), None);
    let names: Vec<&str> = h.b.selection().iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        vec!["core.capabilities", "gallery.pick", "permission.query"]
    );
    let requests_before = h
        .texts()
        .iter()
        .filter(|m| m["type"] == "deviceRequest")
        .count();
    let e = h
        .open(h.spec(
            "mic.record",
            json!({"sampleRate": 16000, "format": "pcm16"}),
        ))
        .unwrap_err();
    assert_eq!((e.code, e.detail), (E::Unsupported, None));
    let requests_after = h
        .texts()
        .iter()
        .filter(|m| m["type"] == "deviceRequest")
        .count();
    assert_eq!(requests_before, requests_after, "nothing was sent");
    // Narrowing and restoring within the ack still work.
    h.snapshot(&["core.capabilities", "permission.query", "mic.record"]);
    assert!(!h.b.supports("gallery.pick"));
    assert!(!h.b.supports("mic.record"));
    h.snapshot(&["core.capabilities", "gallery.pick", "permission.query"]);
    assert!(h.b.supports("gallery.pick"));
    assert!(h.open(h.spec("gallery.pick", gallery_params(1))).is_ok());
}

#[test]
fn in_flight_requests_keep_their_pinned_revision() {
    let mut h = H::new();
    let id = h.gallery(65536);
    h.snapshot(&["core.capabilities"]);
    h.text(blob_start(id, 0, Some(3), "image/jpeg"));
    h.frame(id, 0, 0, b"abc");
    h.text(result(
        id,
        json!({"items": [item(0, "image/jpeg", b"abc")]}),
    ));
    assert!(
        h.settled(id).unwrap().is_ok(),
        "advertisement changes do not cancel work"
    );
}

#[test]
fn the_broker_replenishes_snapshot_credit_itself() {
    let mut h = H::new();
    for _ in 0..20 {
        assert!(h.snapshot(&["core.capabilities", "gallery.pick"]));
    }
    let granted: u64 = h.grants(h.core).iter().sum();
    assert!(granted >= 12, "20 events on credit 8: {granted}");
    assert!(h.closed().is_none());
    assert!(h.b.is_live(h.core));
}

#[test]
fn an_invalid_snapshot_closes_the_device_plane() {
    let mut h = H::new();
    let pending = h.gallery(65536);
    h.text(event(h.core, json!({"capabilities": "all"})));
    assert_eq!(h.cancels(h.core), 1, "the violated stream is cancelled");
    assert_eq!(h.closed().unwrap().0, 1012);
    assert_eq!(h.code(pending), Some(E::ConnectionLost));
    assert!(!h.b.supports("gallery.pick"));
}

#[test]
fn withdrawing_core_capabilities_closes_the_device_plane() {
    let mut h = H::new();
    h.snapshot(&["gallery.pick"]);
    assert!(h.closed().unwrap().1.contains("withdrawn"));
    assert!(h.b.is_closed());
}

#[test]
fn an_unexpected_core_terminal_closes_the_plane_and_fails_in_flight_work() {
    for terminal in [
        result(1, json!({})),
        error(1, "unsupported"),
        error(1, "revoked"),
    ] {
        let mut h = H::new();
        let pick = h.gallery(65536);
        h.text(terminal);
        assert_eq!(h.closed().unwrap().0, 1012);
        assert_eq!(h.code(pick), Some(E::ConnectionLost));
        assert_eq!(h.b.core_stream_id(), None);
        assert!(
            h.settled(h.core).is_none(),
            "the control stream is broker-internal"
        );
    }
}

#[test]
fn a_lease_failure_of_the_core_stream_closes_the_plane() {
    let mut h = H::new();
    h.ack_core = false;
    h.advance(16_000);
    assert_eq!(h.closed().unwrap().0, 1012);
}

#[test]
fn the_core_stream_reopens_before_its_deadline() {
    let mut cfg = config();
    cfg.control_stream_timeout_ms = 10_000;
    let mut h = H::with(cfg);
    let first = h.core;
    h.snapshot(&["core.capabilities"]);
    let before = h.texts().len();
    h.advance(9_000); // lead: a tenth of 10 s
    let after: Vec<Value> = h.texts()[before..].to_vec();
    let cancel = after
        .iter()
        .position(|m| m["id"] == first && m["control"]["cancel"] == true)
        .unwrap();
    let reopen = after
        .iter()
        .position(|m| m["type"] == "deviceRequest" && m["capability"] == "core.capabilities")
        .unwrap();
    assert!(reopen > cancel, "the old stream is retired first");
    let second = h.b.core_stream_id().unwrap();
    assert!(second > first);
    assert!(h.closed().is_none(), "a planned reopen is not a failure");
    h.core = second;
    // The retired stream's late snapshot and terminal are ignored.
    assert!(!h.text(event(
        first,
        json!({"capabilities": [{"name": "core.capabilities", "versions": [1]}]})
    )));
    assert!(!h.text(error(first, "cancelled")));
    h.snapshot(&["core.capabilities", "gallery.pick"]);
    assert!(h.b.supports("gallery.pick"));
}

#[test]
fn the_core_stream_never_reaches_its_deadline() {
    let mut cfg = config();
    cfg.control_stream_timeout_ms = 10_000;
    let mut h = H::with(cfg);
    for _ in 0..35 {
        let core = h.b.core_stream_id().unwrap();
        h.core = core;
        h.advance(1_000);
    }
    assert!(h.closed().is_none());
    assert!(h.requests("core.capabilities").len() >= 4);
    assert_eq!(h.b.live_count(), 1);
}

#[test]
fn hosts_cannot_cancel_the_control_stream() {
    let mut h = H::new();
    h.b.cancel(h.core, h.now);
    h.drain();
    assert!(h.b.is_live(h.core));
    assert_eq!(h.cancels(h.core), 0);
}

// ---------------------------------------------------------------------------
// JSON streams: validation, event credit, token buckets
// ---------------------------------------------------------------------------

#[test]
fn stream_events_are_validated_and_delivered_in_order() {
    let mut h = H::new();
    let id = h.scan(8);
    for n in ["a", "b", "c"] {
        assert!(h.text(event(id, scan_event(n))));
    }
    let names: Vec<Value> = h
        .events(id)
        .iter()
        .map(|e| e["device"]["name"].clone())
        .collect();
    assert_eq!(names, vec![json!("a"), json!("b"), json!("c")]);
    h.text(result(id, json!({})));
    assert!(h.settled(id).unwrap().is_ok());
}

#[test]
fn an_invalid_stream_event_is_never_delivered() {
    let mut h = H::new();
    let id = h.scan(8);
    h.text(event(id, json!({"device": {"id": 7}})));
    assert!(h.events(id).is_empty());
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert_eq!(h.cancels(id), 1);
}

#[test]
fn progress_is_accepted_consumes_no_credit_and_never_goes_back() {
    let mut h = H::new();
    let id = h.scan(2);
    h.text(event(
        id,
        json!({"kind": "progress", "state": "pendingConsent"}),
    ));
    h.text(event(id, json!({"kind": "progress", "state": "running"})));
    assert!(h.events(id).is_empty(), "progress is not delivered");
    assert_eq!(h.b.outstanding_event_credit(id), Some(2));
    h.text(event(
        id,
        json!({"kind": "progress", "state": "pendingConsent"}),
    ));
    assert_eq!(h.detail(id), "progress went back to pendingConsent");

    // Also after data, without an explicit running.
    let mut h = H::new();
    let id = h.gallery(65536);
    h.text(blob_start(id, 0, Some(1), "image/jpeg"));
    h.text(event(
        id,
        json!({"kind": "progress", "state": "pendingConsent"}),
    ));
    assert_eq!(h.detail(id), "progress went back to pendingConsent");
}

#[test]
fn event_credit_comes_back_only_as_the_host_consumes() {
    let mut h = H::new();
    let id = h.scan(4);
    for i in 0..4 {
        h.text(event(id, scan_event(&format!("d{i}"))));
    }
    assert!(h.grants(id).is_empty(), "nothing consumed yet");
    h.b.consumed_events(id, 2, h.now);
    h.drain();
    let granted: u64 = h.grants(id).iter().sum();
    assert!((1..=2).contains(&granted));
    assert_eq!(h.b.outstanding_event_credit(id), Some(granted));
    for i in 0..granted {
        h.text(event(id, scan_event(&format!("e{i}"))));
    }
    assert!(h.b.is_live(id));
    h.text(event(id, scan_event("over")));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert!(h.detail(id).contains("credit"));
    assert_eq!(h.events(id).len() as u64, 4 + granted);
}

#[test]
fn over_reported_event_consumption_earns_no_credit() {
    // 10 "consumed" after 0 deliveries: nothing was handed out, so nothing
    // comes back — and the client stays bound by its initial credit.
    let mut h = H::new();
    let id = h.scan(2);
    h.b.consumed_events(id, 10, h.now);
    h.drain();
    assert!(h.grants(id).is_empty(), "no deliveries, no credit");
    assert_eq!(h.b.outstanding_event_credit(id), Some(2));

    // One delivery, then u64::MAX: credit for exactly that one event.
    h.text(event(id, scan_event("a")));
    assert_eq!(h.b.outstanding_event_credit(id), Some(1));
    h.b.consumed_events(id, u64::MAX, h.now);
    h.drain();
    assert_eq!(h.grants(id), vec![1]);
    assert_eq!(h.b.outstanding_event_credit(id), Some(2));
    // Already reported: repeating the claim is worth nothing.
    h.b.consumed_events(id, u64::MAX, h.now);
    h.b.consumed_events(id, 1, h.now);
    h.drain();
    assert_eq!(h.grants(id), vec![1]);
    // The client still cannot exceed what it was really granted.
    h.text(event(id, scan_event("b")));
    h.text(event(id, scan_event("c")));
    assert!(h.b.is_live(id));
    h.text(event(id, scan_event("over")));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert!(h.detail(id).contains("credit"));
}

#[test]
fn consumed_events_is_constant_time_in_the_reported_count() {
    // A per-event loop would spin ~1.8e19 times here; the clamp makes it
    // O(1), so this returns at once for live, unknown and settled ids.
    let mut h = H::new();
    let id = h.scan(16);
    for i in 0..10 {
        h.text(event(id, scan_event(&format!("d{i}"))));
    }
    assert!(h.b.is_live(id));
    let start = std::time::Instant::now();
    h.b.consumed_events(id, u64::MAX, h.now);
    h.b.consumed_events(id, u64::MAX, h.now);
    h.b.consumed_events(9_999, u64::MAX, h.now);
    h.drain();
    // All 10 delivered events come back as one batched grant.
    assert_eq!(h.grants(id), vec![10]);
    assert_eq!(h.b.outstanding_event_credit(id), Some(16));
    h.b.cancel(id, h.now);
    h.b.consumed_events(id, u64::MAX, h.now);
    h.drain();
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(h.grants(id), vec![10], "a settled stream earns nothing");
}

#[test]
fn over_reported_data_consumption_releases_only_what_was_delivered() {
    let mut h = H::new();
    let id = h.mic(4096);
    h.b.consumed_data(id, usize::MAX, h.now);
    h.drain();
    assert!(h.grants(id).is_empty(), "no chunks, nothing to release");
    assert_eq!(h.b.outstanding_credit(id), Some(4096));

    h.text(blob_start(id, 0, None, "audio/L16"));
    for seq in 0..4 {
        assert!(h.frame(id, 0, seq, &[1u8; 1024]));
    }
    let held = h.b.retained_bytes();
    assert!(held >= 4 * 1024);
    assert_eq!(h.b.outstanding_credit(id), Some(0));
    // Consuming "everything" releases exactly the four delivered chunks,
    // in one batched grant, and returns at once.
    h.b.consumed_data(id, usize::MAX, h.now);
    h.drain();
    assert_eq!(h.grants(id), vec![4096]);
    assert_eq!(h.b.retained_bytes(), held - 4 * 1024);
    h.b.consumed_data(id, usize::MAX, h.now);
    h.drain();
    assert_eq!(h.grants(id), vec![4096], "nothing left to consume");
    // The accounting stays exact for the next chunk.
    assert!(h.frame(id, 0, 4, &[2u8; 1024]));
    assert_eq!(h.data(id).len(), 5);
    assert!(h.b.retained_bytes() > held - 4 * 1024);
    h.b.consumed_data(id, 7, h.now);
    h.drain();
    assert_eq!(h.b.retained_bytes(), held - 4 * 1024);
}

#[test]
fn over_reported_consumption_on_a_draining_stream_settles_once() {
    let mut h = H::new();
    let id = h.mic(64);
    h.text(blob_start(id, 0, None, "audio/L16"));
    h.frame(id, 0, 0, b"ab");
    h.frame(id, 0, 1, b"cd");
    h.text(result(
        id,
        json!({"durationMs": 1, "item": item(0, "audio/L16", b"abcd")}),
    ));
    assert_eq!(h.b.draining_count(), 1);
    h.b.consumed_data(id, usize::MAX, h.now);
    h.drain();
    assert!(matches!(h.settled(id), Some(Outcome::Ok { .. })));
    assert_eq!(h.b.retained_bytes(), 0);
    h.b.consumed_data(id, usize::MAX, h.now);
    h.drain();
    assert_eq!(h.settle_count(id), 1);
}

#[test]
fn host_times_near_u64_max_never_overflow() {
    // Times are host-supplied: opening, renewing and reopening the control
    // stream at the end of the u64 range saturate instead of overflowing
    // (a debug build used to panic on `now + 5000`).
    let mut cfg = config();
    cfg.control_stream_timeout_ms = 10_000;
    let near = u64::MAX - 3;
    let mut b = DeviceBroker::new(cfg, near);
    b.start(near).expect("core.capabilities opens");
    assert!(b.owner_activated("m1", 1, near));
    let mut spec = OpenSpec::new("bluetooth.scan", json!({}), "m1", 1);
    spec.initial_credit = Some(4);
    let id = b.open(spec, near).expect("opens");
    b.poll();
    for now in [near + 1, u64::MAX, u64::MAX] {
        b.tick(now);
        b.poll();
    }
    b.consumed_events(id, u64::MAX, u64::MAX);
    b.set_transport_buffered(usize::MAX);
    b.tick(u64::MAX);
    b.poll();
    assert!(b.next_deadline().is_some());
}

#[test]
fn event_credit_never_exceeds_the_revision_bound() {
    let mut h = H::new();
    let id = h.scan(256);
    for i in 0..200 {
        h.text(event(id, scan_event(&format!("d{i}"))));
        h.b.consumed_events(id, 1, h.now);
        h.drain();
        assert!(h.b.outstanding_event_credit(id).unwrap() <= 1024);
    }
    assert!(h.b.is_live(id));
}

#[test]
fn stream_control_rules_grant_and_paused() {
    let mut h = H::new();
    let id = h.scan(4);
    h.text(control(id, json!({"grant": 4})));
    assert_eq!(
        h.code(id),
        Some(E::InvalidParams),
        "grant from the data sender"
    );

    let mut h = H::new();
    let id = h.scan(4);
    h.text(control(id, json!({"paused": true})));
    assert!(h.b.is_live(id));
    h.text(event(id, scan_event("x")));
    assert_eq!(
        h.detail(id),
        "stream event while the sender reported paused"
    );

    let mut h = H::new();
    let id = h.scan(4);
    h.text(control(id, json!({"paused": true})));
    h.text(control(id, json!({"paused": false})));
    assert!(h.b.is_live(id));
    h.text(control(id, json!({"paused": false})));
    assert!(h.detail(id).contains("repeats the current state"));

    let mut h = H::new();
    let id = h.permission();
    h.text(control(id, json!({"paused": true})));
    assert_eq!(h.detail(id), "wrong-direction control: paused");
}

#[test]
fn a_stream_is_cancelled_and_swept_like_any_request() {
    let mut h = H::new();
    let id = h.scan(4);
    h.b.cancel(id, h.now);
    h.drain();
    assert_eq!((h.cancels(id), h.code(id)), (1, Some(E::Cancelled)));
    let id = h.scan(4);
    h.b.owner_deactivated("m1", 1, h.now);
    h.drain();
    assert_eq!(h.code(id), Some(E::Cancelled));
}

fn rate_broker(rate: EventRate) -> H {
    let mut cfg = config();
    cfg.event_rate = rate;
    H::with(cfg)
}

#[test]
fn the_per_request_bucket_throttles_a_burst_with_credit_to_spare() {
    let mut h = rate_broker(EventRate {
        request_burst: 3.0,
        request_per_second: 1.0,
        ..EventRate::default()
    });
    let id = h.scan(256);
    for _ in 0..4 {
        h.text(event(id, scan_event("x")));
    }
    assert_eq!(
        h.settled(id),
        Some(&Outcome::Err {
            code: E::Throttled,
            detail: Some("event rate limit".into())
        })
    );
}

#[test]
fn the_per_request_bucket_refills_with_time() {
    let mut h = rate_broker(EventRate {
        request_burst: 2.0,
        request_per_second: 2.0,
        ..EventRate::default()
    });
    let id = h.scan(256);
    for _ in 0..10 {
        h.text(event(id, scan_event("x")));
        h.b.consumed_events(id, 1, h.now);
        h.text(control(
            id,
            json!({"leaseAck": h.renewals(id).last().unwrap().0}),
        ));
        h.advance(600);
    }
    assert!(h.b.is_live(id));
}

#[test]
fn the_per_connection_bucket_bounds_floods_spread_over_requests() {
    let mut h = rate_broker(EventRate {
        request_burst: 100.0,
        request_per_second: 128.0,
        connection_burst: 5.0,
        connection_per_second: 1.0,
    });
    let ids = [h.scan(64), h.scan(64), h.scan(64)];
    for i in 0..6 {
        h.text(event(ids[i % 3], scan_event("x")));
    }
    let throttled = ids
        .iter()
        .filter(|&&id| h.code(id) == Some(E::Throttled))
        .count();
    assert_eq!(throttled, 1);
}

#[test]
fn a_flood_on_a_credit_eight_stream_stops_at_the_ninth_event() {
    let mut h = H::new();
    let id = h.scan(8);
    let mut accepted = 0;
    for _ in 0..100_000 {
        if !h.b.is_live(id) {
            break;
        }
        h.b.on_text(&event(id, scan_event("x")).to_string(), h.now);
        if h.b.is_live(id) {
            accepted += 1;
        }
    }
    h.drain();
    assert_eq!(
        accepted, 8,
        "a consumer that never catches up grants nothing"
    );
    assert_eq!(h.code(id), Some(E::InvalidParams));
}

// ---------------------------------------------------------------------------
// streamed uploads (mic.record)
// ---------------------------------------------------------------------------

#[test]
fn a_streamed_upload_hands_bytes_to_the_host_in_order_and_settles_after_consumption() {
    let mut h = H::new();
    let id = h.mic(64);
    h.text(blob_start(id, 0, None, "audio/L16"));
    let chunks: [&[u8]; 3] = [b"0123456789abcdef", b"ghijklmnopqrstuv", b"wxyz"];
    for (seq, c) in chunks.iter().enumerate() {
        assert!(h.frame(id, 0, seq as u32, c));
    }
    assert_eq!(
        h.data(id),
        chunks.iter().map(|c| c.to_vec()).collect::<Vec<_>>()
    );
    assert!(
        h.b.retained_bytes() >= 3 * 1024,
        "unconsumed chunks hold budget"
    );
    let all: Vec<u8> = chunks.concat();
    h.text(result(
        id,
        json!({"durationMs": 10, "item": item(0, "audio/L16", &all)}),
    ));
    assert!(h.settled(id).is_none(), "success waits for the consumer");
    assert_eq!(h.b.draining_count(), 1);
    assert!(!h.b.is_live(id), "the id is retired");
    h.b.consumed_data(id, 2, h.now);
    h.drain();
    assert!(h.settled(id).is_none());
    h.b.consumed_data(id, 1, h.now);
    h.drain();
    match h.settled(id).unwrap() {
        Outcome::Ok { result, blobs, .. } => {
            assert!(blobs.is_empty(), "nothing buffered");
            assert_eq!(result["item"]["bytes"], all.len());
        }
        o => panic!("{o:?}"),
    }
    assert_eq!(h.b.retained_bytes(), 0);
    assert_eq!(h.b.draining_count(), 0);
}

#[test]
fn streamed_credit_is_replenished_only_as_chunks_are_consumed() {
    let mut h = H::new();
    let id = h.mic(4096);
    h.text(blob_start(id, 0, None, "audio/L16"));
    for seq in 0..4 {
        assert!(h.frame(id, 0, seq, &[1u8; 1024]));
    }
    assert!(
        h.grants(id).is_empty(),
        "a slow consumer backpressures the recorder"
    );
    assert_eq!(h.b.outstanding_credit(id), Some(0));
    h.text(control(id, json!({"paused": true})));
    assert!(
        h.grants(id).is_empty(),
        "no window top-up while chunks are unconsumed"
    );
    h.b.consumed_data(id, 4, h.now);
    h.drain();
    let granted: u64 = h.grants(id).iter().sum();
    assert!(
        granted >= 4096,
        "credit returns as the sink catches up: {granted}"
    );
    assert!(h.b.outstanding_credit(id).unwrap() <= 1024 * 1024);
}

#[test]
fn a_streamed_sha256_mismatch_is_invalid_params() {
    let mut h = H::new();
    let id = h.mic(64);
    h.text(blob_start(id, 0, None, "audio/L16"));
    h.frame(id, 0, 0, b"abcd");
    h.b.consumed_data(id, 1, h.now);
    h.text(result(
        id,
        json!({"durationMs": 1, "item": item(0, "audio/L16", b"abce")}),
    ));
    assert_eq!(h.detail(id), "channel 0: sha256 mismatch");
}

#[test]
fn an_abandoned_drain_times_out_and_releases_its_budget() {
    let mut cfg = config();
    cfg.drain_timeout_ms = 1_000;
    let mut h = H::with(cfg);
    let id = h.mic(64);
    h.text(blob_start(id, 0, None, "audio/L16"));
    h.frame(id, 0, 0, b"abcd");
    h.text(result(
        id,
        json!({"durationMs": 1, "item": item(0, "audio/L16", b"abcd")}),
    ));
    assert_eq!(h.b.draining_count(), 1);
    h.advance(999);
    assert!(h.settled(id).is_none());
    h.advance(1);
    assert_eq!(h.code(id), Some(E::Timeout));
    assert_eq!(h.b.retained_bytes(), 0);
    h.b.consumed_data(id, 1, h.now);
    h.drain();
    assert_eq!(h.settle_count(id), 1, "a late consumer changes nothing");
}

#[test]
fn draining_streams_are_reachable_by_cancel_sweep_and_close() {
    for how in ["cancel", "sweep", "close"] {
        let mut h = H::new();
        let id = h.mic(64);
        h.text(blob_start(id, 0, None, "audio/L16"));
        h.frame(id, 0, 0, b"abcd");
        h.text(result(
            id,
            json!({"durationMs": 1, "item": item(0, "audio/L16", b"abcd")}),
        ));
        let texts = h.texts().len();
        match how {
            "cancel" => h.b.cancel(id, h.now),
            "sweep" => h.b.owner_deactivated("m1", 1, h.now),
            _ => h.b.close(E::ConnectionLost),
        }
        h.drain();
        let want = if how == "close" {
            E::ConnectionLost
        } else {
            E::Cancelled
        };
        assert_eq!(h.code(id), Some(want), "{how}");
        assert_eq!(
            h.texts().len(),
            texts,
            "{how}: the retired id gets no cancel"
        );
        assert_eq!(h.b.retained_bytes(), 0, "{how}");
        assert_eq!(h.b.draining_count(), 0);
    }
}

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

fn scripted() -> Vec<Output> {
    let mut h = H::new();
    let pick = h.gallery(1024);
    let scan = h.scan(4);
    let save = h
        .open(OpenSpec::save(
            "r.txt",
            "text/plain",
            b"hello world".to_vec(),
            "m1",
            1,
        ))
        .unwrap();
    h.text(blob_start(pick, 0, Some(1500), "image/jpeg"));
    h.frame(pick, 0, 0, &[3u8; 1000]);
    h.text(control(pick, json!({"paused": true})));
    h.text(event(scan, scan_event("a")));
    h.text(control(save, json!({"grant": 4})));
    h.advance(7_000);
    h.text(control(save, json!({"grant": 64})));
    h.advance(20_000);
    h.log.into_iter().map(|(_, o)| o).collect()
}

#[test]
fn identical_inputs_give_identical_outputs() {
    let a = scripted();
    let b = scripted();
    assert!(a.len() > 10);
    assert_eq!(a, b);
}

// ---------------------------------------------------------------------------
// payload diagnostics
// ---------------------------------------------------------------------------

/// Local refusals and violation details name the failing JSON path and
/// rule, so every SDK on this broker gets field-level diagnostics.
#[test]
fn payload_refusals_and_violations_name_the_failing_field() {
    let mut h = H::new();
    let err = h
        .open(h.spec(
            "gallery.pick",
            json!({"mediaTypes": ["vid"], "maxCount": 1}),
        ))
        .unwrap_err();
    assert_eq!(err.code, E::InvalidParams);
    assert_eq!(
        err.detail.as_deref(),
        Some("params $.mediaTypes[0]: unknown variant `vid`, expected `photo` or `video`")
    );
    let err = h
        .open(h.spec("permission.query", json!({"permission": "camera", "x": 1})))
        .unwrap_err();
    assert!(
        err.detail
            .as_deref()
            .unwrap()
            .starts_with("params $.x: unknown field `x`"),
        "{err:?}"
    );

    // A client result that breaks the schema: the violation names the item.
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, None, "image/jpeg"));
    h.frame(id, 0, 0, b"abcd");
    let mut bad = item(0, "image/jpeg", b"abcd");
    bad["sha256"] = json!("NOT-HEX");
    h.text(result(id, json!({"items": [bad]})));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert_eq!(
        h.detail(id),
        "result $.items[0].sha256: sha256 must be 64 lowercase hex digits"
    );

    // A stream event that breaks the schema.
    let id = h.scan(4);
    h.text(event(id, json!({"device": {"id": "a", "rssi": "loud"}})));
    assert_eq!(
        h.detail(id),
        "event $.device.rssi: invalid type: string \"loud\", expected i16"
    );
}

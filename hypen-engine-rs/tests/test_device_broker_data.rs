//! Device broker (RFC 001 §2.3/§2.4/§5) — the data planes: upload credit
//! and declarations, retained-bytes budgets (per connection and pooled),
//! the 1-byte-frame attack, empty frames and zero-byte items, blob
//! verification, held results, downloads within client credit, and the
//! bulk transport scheduler. Ported from the TS suites (device-credit,
//! device-download, device-scheduling, device-srv-budget,
//! device-srv-round2, device-srv-scheduling, device-srv-validation).

mod device_broker_support;

use device_broker_support::*;
use hypen_engine::device::{
    file_save_params, sha256_hex, BulkScheduler, OpenSpec, Outcome, RetainedBytesPool,
    RevisionOverride, SchedulerConfig, DEFAULT_MAX_RETAINED_BYTES, DO_MAX_RETAINED_BYTES,
    MAX_QUEUED_BULK_BYTES,
};
use hypen_engine::serialize::device::{find_revision, DeviceErrorCode as E};
use serde_json::json;

fn gallery_items(items: &[serde_json::Value]) -> serde_json::Value {
    json!({ "items": items })
}

// ---------------------------------------------------------------------------
// upload credit and declarations
// ---------------------------------------------------------------------------

#[test]
fn a_frame_beyond_outstanding_credit_is_invalid_params_and_cancel() {
    let mut h = H::new();
    let id = h.gallery(10);
    h.text(blob_start(id, 0, Some(100), "image/jpeg"));
    assert!(!h.frame(id, 0, 0, &[7; 20]));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert!(h.detail(id).contains("credit"));
    assert_eq!(h.cancels(id), 1);
    assert_eq!(h.b.retained_bytes(), 0, "buffered data discarded");
}

#[test]
fn a_frame_beyond_the_declaration_is_invalid_params() {
    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, Some(10), "image/jpeg"));
    assert!(h.frame(id, 0, 0, &[7; 8]));
    assert!(!h.frame(id, 0, 1, &[7; 8]));
    assert!(h.detail(id).contains("declared"));
    assert_eq!(h.cancels(id), 1);
}

#[test]
fn a_frame_before_blob_start_allocates_nothing() {
    let mut h = H::new();
    let id = h.gallery(1000);
    assert!(!h.frame(id, 0, 0, &[7; 8]));
    assert!(h.detail(id).contains("before blobStart"));
    assert_eq!(h.b.retained_bytes(), 0);
}

#[test]
fn channels_are_bounded_by_max_count_and_the_revision() {
    let mut h = H::new();
    let id = h.gallery(1000);
    for c in 0..16 {
        h.text(blob_start(id, c, Some(1), "image/jpeg"));
    }
    assert!(h.b.is_live(id));
    h.text(blob_start(id, 16, Some(1), "image/jpeg"));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert!(h.detail(id).contains("item"), "{}", h.detail(id));

    let mut h = H::new();
    let id = h.open(h.spec("gallery.pick", gallery_params(2))).unwrap();
    h.text(blob_start(id, 0, Some(1), "image/jpeg"));
    h.text(blob_start(id, 2, Some(1), "image/jpeg"));
    assert!(h
        .detail(id)
        .contains("outside the 2 items this request allows"));
}

#[test]
fn an_oversize_declaration_is_refused_before_any_sink() {
    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, Some(64 * MIB as u64 + 1), "image/jpeg"));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert_eq!(h.b.retained_bytes(), 0);
}

#[test]
fn duplicate_channels_and_sequence_gaps_are_violations() {
    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, Some(10), "image/jpeg"));
    h.text(blob_start(id, 0, Some(10), "image/jpeg"));
    assert!(h.detail(id).contains("duplicate channel 0"));

    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, Some(10), "image/jpeg"));
    assert!(!h.frame(id, 0, 1, &[1; 4]), "seq 0 skipped");
    assert_eq!(h.detail(id), "channel 0: seq 1, expected 0");
}

#[test]
fn blob_traffic_on_a_request_without_an_upload_plane_is_a_violation() {
    let mut h = H::new();
    let id = h.permission();
    h.text(blob_start(id, 0, Some(4), "image/jpeg"));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    let id = h.permission();
    assert!(!h.frame(id, 0, 0, b"abc"));
    assert!(h.detail(id).contains("no client→server data plane"));
    let id = h.scan(4);
    assert!(!h.frame(id, 0, 0, b"abc"));
    assert_eq!(h.code(id), Some(E::InvalidParams));
}

#[test]
fn replenishment_is_batched_and_never_exceeds_max_outstanding_credit() {
    let mut rev = *find_revision("gallery.pick", 1).unwrap();
    rev.max_outstanding_credit = 100;
    let mut cfg = config();
    cfg.revision_overrides.push(RevisionOverride {
        capability: "gallery.pick".into(),
        revision: rev,
    });
    let mut h = H::with(cfg);
    // A sender-side overshoot of the bound (150 > 100) is not topped up;
    // replenishment waits until half the initial window (75) was consumed.
    let id = h.gallery(150);
    h.text(blob_start(id, 0, Some(10_000), "image/jpeg"));
    assert!(h.frame(id, 0, 0, &[1; 30]));
    assert!(h.frame(id, 0, 1, &[1; 30]));
    assert!(h.grants(id).is_empty(), "60 consumed < 75");
    assert_eq!(h.b.outstanding_credit(id), Some(90));
    for seq in 2..12 {
        assert!(h.frame(id, 0, seq, &[1; 50]));
        let c = h.b.outstanding_credit(id).unwrap();
        assert!(c <= 100 && c > 0, "bounded and never starved: {c}");
    }
    assert_eq!(h.grants(id), vec![60, 100, 100, 100, 100]);
}

#[test]
fn a_grant_from_the_upload_sender_is_wrong_direction() {
    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(control(id, json!({"grant": 10})));
    assert_eq!(
        h.detail(id),
        "grant on a request whose data flows client→server"
    );
}

#[test]
fn paused_widens_the_window_to_one_chunk() {
    let mut h = H::new();
    let id = h.gallery(16);
    h.text(blob_start(id, 0, None, "image/jpeg"));
    assert!(h.frame(id, 0, 0, &[1; 16]));
    h.text(control(id, json!({"paused": true})));
    assert_eq!(
        h.b.outstanding_credit(id),
        Some(64 * KIB as u64),
        "one maximum chunk"
    );
    h.text(control(id, json!({"paused": false})));
    assert!(h.frame(id, 0, 1, &[1; 64 * KIB]));
    assert!(!h.frame(id, 0, 2, &[1; 64 * KIB + 1]), "over 64 KiB");
    assert!(h.detail(id).contains("above 65536"));
    let mut h = H::new();
    let id = h.gallery(16);
    h.text(control(id, json!({"paused": true})));
    h.text(blob_start(id, 0, None, "image/jpeg"));
    assert!(!h.frame(id, 0, 0, b"x"), "no data while paused");
    assert!(h.detail(id).contains("paused"));
}

#[test]
fn a_transfer_larger_than_the_initial_credit_completes_and_verifies() {
    let mut h = H::new();
    let id = h.gallery(64 * KIB as u64);
    let bytes: Vec<u8> = (0..300 * KIB).map(|i| (i * 7 % 251) as u8).collect();
    h.text(blob_start(id, 0, Some(bytes.len() as u64), "image/jpeg"));
    let (mut off, mut seq) = (0usize, 0u32);
    while off < bytes.len() {
        let credit = h.b.outstanding_credit(id).unwrap() as usize;
        assert!(credit > 0, "the client is never starved");
        let n = credit.min(16 * KIB).min(bytes.len() - off);
        assert!(h.frame(id, 0, seq, &bytes[off..off + n]));
        off += n;
        seq += 1;
    }
    h.text(result(id, gallery_items(&[item(0, "image/jpeg", &bytes)])));
    match h.settled(id).unwrap() {
        Outcome::Ok { blobs, .. } => {
            assert_eq!(blobs.len(), 1);
            assert_eq!(blobs[0].bytes, bytes);
            assert_eq!(blobs[0].content_type, "image/jpeg");
        }
        o => panic!("{o:?}"),
    }
    assert_eq!(h.b.retained_bytes(), 0);
}

#[test]
fn result_items_must_match_what_was_announced_and_received() {
    type Case = (&'static str, serde_json::Value);
    let bytes = b"abcd";
    let cases: Vec<Case> = vec![
        (
            "contentType differs",
            gallery_items(&[item(0, "image/png", bytes)]),
        ),
        (
            "duplicate item channel",
            gallery_items(&[item(0, "image/jpeg", bytes), item(0, "image/jpeg", bytes)]),
        ),
        (
            "declares 0 items, blobStart announced 1",
            gallery_items(&[]),
        ),
        (
            "unannounced channel 3",
            gallery_items(&[item(3, "image/jpeg", bytes)]),
        ),
        ("states 999 bytes, received 4", {
            let mut it = item(0, "image/jpeg", bytes);
            it["bytes"] = json!(999);
            gallery_items(&[it])
        }),
        (
            "sha256 mismatch",
            gallery_items(&[item(0, "image/jpeg", b"abce")]),
        ),
    ];
    for (why, res) in cases {
        let mut h = H::new();
        let id = h.gallery(1000);
        h.text(blob_start(id, 0, None, "image/jpeg"));
        h.frame(id, 0, 0, bytes);
        h.text(result(id, res));
        assert_eq!(h.code(id), Some(E::InvalidParams), "{why}");
        assert!(h.detail(id).contains(why), "{why}: {}", h.detail(id));
        assert_eq!(h.cancels(id), 0, "the client's own terminal: no cancel");
        assert_eq!(h.b.retained_bytes(), 0);
    }
    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(result(id, gallery_items(&[item(0, "image/jpeg", b"abc")])));
    assert!(
        h.detail(id).contains("blobStart announced 0"),
        "items never announced"
    );
}

#[test]
fn camera_items_must_fit_the_requested_mode() {
    let mut h = H::new();
    let id = h
        .open(h.spec("camera.capture", json!({"mode": "photo"})))
        .unwrap();
    h.text(blob_start(id, 0, None, "video/mp4"));
    assert!(h.detail(id).contains("does not fit the request"));
    let id = h
        .open(h.spec("camera.capture", json!({"mode": "video"})))
        .unwrap();
    h.text(blob_start(id, 0, None, "video/webm"));
    h.frame(id, 0, 0, b"vid");
    h.text(result(id, gallery_items(&[item(0, "video/webm", b"vid")])));
    assert!(h.settled(id).unwrap().is_ok());
}

#[test]
fn file_pick_names_ride_on_the_verified_blobs() {
    let mut h = H::new();
    let id = h
        .open(h.spec(
            "file.pick",
            json!({"accept": ["application/pdf"], "maxCount": 2}),
        ))
        .unwrap();
    h.text(blob_start(id, 0, Some(3), "application/pdf"));
    h.text(blob_start(id, 1, Some(2), "application/pdf"));
    h.frame(id, 1, 0, b"yz");
    h.frame(id, 0, 0, b"pdf");
    let mut a = item(0, "application/pdf", b"pdf");
    a["name"] = json!("a.pdf");
    let mut b = item(1, "application/pdf", b"yz");
    b["name"] = json!("b.pdf");
    h.text(result(id, json!({"items": [b, a]})));
    match h.settled(id).unwrap() {
        Outcome::Ok { blobs, .. } => {
            let got: Vec<(u16, Option<&str>, &[u8])> = blobs
                .iter()
                .map(|b| (b.channel, b.name.as_deref(), b.bytes.as_slice()))
                .collect();
            assert_eq!(
                got,
                vec![
                    (1, Some("b.pdf"), &b"yz"[..]),
                    (0, Some("a.pdf"), &b"pdf"[..])
                ]
            );
        }
        o => panic!("{o:?}"),
    }
}

#[test]
fn revoked_settles_as_a_value_and_discards_the_partial_upload() {
    let mut h = H::new();
    let id = h.gallery(65536);
    h.text(blob_start(id, 0, Some(1000), "image/jpeg"));
    assert!(h.frame(id, 0, 0, &[1; 500]));
    h.text(error(id, "revoked"));
    assert_eq!(h.code(id), Some(E::Revoked));
    assert!(
        !h.frame(id, 0, 1, &[1; 500]),
        "the rest is dropped without storage"
    );
    assert_eq!(h.cancels(id), 0);
    assert_eq!(h.b.retained_bytes(), 0);
    assert_eq!(h.b.live_count(), 1);
}

// ---------------------------------------------------------------------------
// empty frames, zero-byte items (decision D2), sizes (decision D5)
// ---------------------------------------------------------------------------

#[test]
fn an_empty_frame_flood_at_zero_credit_stops_at_frame_one() {
    let mut h = H::new();
    let mut spec = h.spec("gallery.pick", gallery_params(16));
    spec.initial_credit = Some(0);
    spec.allow_zero_credit = true;
    let id = h.open(spec).unwrap();
    assert_eq!(h.requests("gallery.pick")[0]["initialCredit"], 0);
    h.text(blob_start(id, 0, Some(10), "image/jpeg"));
    let mut accepted = 0;
    for seq in 0..300_000u32 {
        if h.b.on_frame(&frame(id, 0, seq, &[]), h.now) {
            accepted += 1;
        }
    }
    h.drain();
    assert_eq!(accepted, 0);
    assert!(h.detail(id).contains("zero-length"));
    assert_eq!(h.cancels(id), 1);
    assert_eq!(h.b.live_count(), 1);
}

#[test]
fn zero_byte_items_send_no_frames_and_verify_empty() {
    let empty_sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    for declared in [Some(0), None] {
        let mut h = H::new();
        let id = h.gallery(1000);
        h.text(blob_start(id, 0, declared, "image/jpeg"));
        h.text(result(
            id,
            gallery_items(&[
                json!({"channel": 0, "contentType": "image/jpeg", "bytes": 0, "sha256": empty_sha}),
            ]),
        ));
        match h.settled(id).unwrap() {
            Outcome::Ok { blobs, .. } => assert!(blobs[0].bytes.is_empty()),
            o => panic!("{declared:?}: {o:?}"),
        }
        assert_eq!(h.cancels(id), 0);
    }
    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, Some(0), "image/jpeg"));
    assert!(!h.frame(id, 0, 0, &[]));
    assert!(h.detail(id).contains("zero-length"));
}

#[test]
fn undeclared_items_are_bounded_as_bytes_arrive() {
    let mut cfg = config();
    cfg.max_item_bytes = Some(100);
    let mut h = H::with(cfg);
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, None, "image/jpeg"));
    assert!(h.frame(id, 0, 0, &[1; 60]));
    assert!(!h.frame(id, 0, 1, &[1; 41]));
    assert!(h.detail(id).contains("max item bytes 100"));
}

#[test]
fn a_declared_size_must_be_reached_and_undeclared_terminals_state_what_arrived() {
    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, Some(4), "image/jpeg"));
    h.frame(id, 0, 0, &[1, 2, 3]);
    h.text(result(
        id,
        gallery_items(&[item(0, "image/jpeg", &[1, 2, 3])]),
    ));
    assert!(h.detail(id).contains("3 of 4 declared"));

    let mut h = H::new();
    let id = h.gallery(1000);
    h.text(blob_start(id, 0, None, "image/jpeg"));
    h.frame(id, 0, 0, &[1, 2, 3]);
    let mut it = item(0, "image/jpeg", &[1, 2, 3]);
    it["bytes"] = json!(999);
    h.text(result(id, gallery_items(&[it])));
    assert!(h.detail(id).contains("states 999 bytes, received 3"));
}

// ---------------------------------------------------------------------------
// retained-bytes budgets (§2.4/§5)
// ---------------------------------------------------------------------------

#[test]
fn defaults_match_the_host_profiles() {
    assert_eq!(DEFAULT_MAX_RETAINED_BYTES, 128 * MIB as u64);
    assert_eq!(DO_MAX_RETAINED_BYTES, 16 * MIB as u64);
    assert_eq!(H::new().b.max_retained_bytes(), 128 * MIB as u64);
    assert_eq!(MAX_QUEUED_BULK_BYTES, 8 * MIB);
}

#[test]
fn declared_totals_across_requests_are_checked_at_blob_start() {
    let mut cfg = config();
    cfg.max_retained_bytes = 100;
    let mut h = H::with(cfg);
    let a = h.gallery(64);
    let b = h.gallery(64);
    h.text(blob_start(a, 0, Some(60), "image/jpeg"));
    assert_eq!(h.b.retained_bytes(), 60);
    h.text(blob_start(b, 0, Some(30), "image/jpeg"));
    assert_eq!(h.b.retained_bytes(), 90);
    h.text(blob_start(b, 1, Some(20), "image/jpeg"));
    assert_eq!(h.code(b), Some(E::Throttled));
    assert!(h.detail(b).contains("connection byte budget 100 exceeded"));
    assert_eq!(h.b.retained_bytes(), 60, "b's reservation released");
    assert!(h.b.is_live(a));
}

#[test]
fn reservations_are_released_on_every_terminal() {
    let mut cfg = config();
    cfg.max_retained_bytes = 100 * KIB as u64;
    let mut h = H::with(cfg);
    for end in ["cancel", "error", "success", "violation"] {
        let id = h.gallery(64 * KIB as u64);
        h.text(blob_start(id, 0, Some(90 * KIB as u64), "image/jpeg"));
        assert_eq!(h.b.retained_bytes(), 90 * KIB as u64, "{end}");
        match end {
            "cancel" => {
                h.b.cancel(id, h.now);
                h.drain();
            }
            "error" => {
                h.text(error(id, "denied"));
            }
            "success" => {
                let bytes = vec![5u8; 90 * KIB];
                assert!(h.frame(id, 0, 0, &bytes[..60 * KIB]));
                assert!(h.frame(id, 0, 1, &bytes[60 * KIB..]));
                assert_eq!(
                    h.b.retained_bytes(),
                    90 * KIB as u64,
                    "charged exactly the declaration"
                );
                h.text(result(id, gallery_items(&[item(0, "image/jpeg", &bytes)])));
                assert!(h.settled(id).unwrap().is_ok());
            }
            _ => {
                h.text(control(id, json!({"grant": 1})));
            }
        }
        assert_eq!(h.b.retained_bytes(), 0, "{end}");
    }
}

#[test]
fn sixteen_maximum_items_cannot_be_declared_on_one_connection() {
    let mut h = H::new();
    let id = h.gallery(64 * KIB as u64);
    for c in 0..16 {
        if !h.b.is_live(id) {
            break;
        }
        h.text(blob_start(id, c, Some(64 * MIB as u64), "image/jpeg"));
    }
    assert_eq!(h.code(id), Some(E::Throttled));
    assert_eq!(h.b.retained_bytes(), 0);
}

#[test]
fn a_durable_object_profile_caps_items_and_downloads() {
    let mut cfg = config();
    cfg.max_retained_bytes = DO_MAX_RETAINED_BYTES;
    cfg.max_item_bytes = Some(DO_MAX_RETAINED_BYTES);
    let mut h = H::with(cfg);
    assert_eq!(
        h.b.revision("gallery.pick", 1).unwrap().max_item_bytes,
        16 * MIB as u64
    );
    let id = h.gallery(64 * KIB as u64);
    h.text(blob_start(id, 0, Some(17 * MIB as u64), "image/jpeg"));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert_eq!(h.b.retained_bytes(), 0);
    assert_eq!(h.cancels(id), 1);
    let big = vec![0u8; 16 * MIB + 1];
    let err = h
        .open(OpenSpec::save(
            "big.bin",
            "application/octet-stream",
            big,
            "m1",
            1,
        ))
        .unwrap_err();
    assert_eq!(err.code, E::InvalidParams);
    assert!(h.requests("file.save").is_empty());
    // The default host keeps the registry's 64 MiB item cap.
    assert_eq!(
        H::new()
            .b
            .revision("gallery.pick", 1)
            .unwrap()
            .max_item_bytes,
        64 * MIB as u64
    );
}

#[test]
fn every_tiny_frame_costs_at_least_one_kib_of_budget() {
    let mut cfg = config();
    cfg.max_retained_bytes = 64 * KIB as u64;
    let mut h = H::with(cfg);
    let id = h.gallery(65536);
    h.text(blob_start(id, 0, None, "image/jpeg"));
    let mut accepted = 0;
    for seq in 0..1000 {
        if !h.frame(id, 0, seq, &[7]) {
            break;
        }
        accepted += 1;
    }
    assert_eq!(accepted, 64);
    assert_eq!(h.code(id), Some(E::Throttled));
    assert_eq!(h.b.retained_bytes(), 0);
}

#[test]
fn a_two_million_one_byte_frame_attack_is_bounded_by_the_budget() {
    let mut h = H::new();
    let id = h.gallery(4 * MIB as u64);
    h.text(blob_start(id, 0, None, "image/jpeg"));
    let mut buf = frame(id, 0, 0, &[9]);
    let mut accepted = 0u64;
    let started = std::time::Instant::now();
    for seq in 0..2_000_000u32 {
        buf[8..12].copy_from_slice(&seq.to_le_bytes());
        if h.b.on_frame(&buf, h.now) {
            accepted += 1;
        }
    }
    h.drain();
    // 128 MiB budget / 1 KiB minimum charge per frame.
    assert_eq!(accepted, 128 * 1024);
    assert_eq!(h.code(id), Some(E::Throttled));
    assert_eq!(
        h.b.retained_bytes(),
        0,
        "everything released with the request"
    );
    assert!(
        started.elapsed().as_secs() < 60,
        "linear, cheap rejection after the cutoff"
    );
}

#[test]
fn a_maximum_declared_item_with_a_short_last_chunk_fits_a_budget_equal_to_it() {
    let budget = 64 * KIB;
    let mut cfg = config();
    cfg.max_retained_bytes = budget as u64;
    cfg.max_item_bytes = Some(budget as u64);
    let mut h = H::with(cfg);
    let id = h.gallery(65536);
    h.text(blob_start(id, 0, Some(budget as u64), "image/jpeg"));
    let bytes = vec![3u8; budget];
    let (mut off, mut seq) = (0, 0);
    while off + 65_000 <= budget {
        assert!(h.frame(id, 0, seq, &bytes[off..off + 65_000]));
        off += 65_000;
        seq += 1;
    }
    h.text(control(id, json!({"paused": true})));
    h.text(control(id, json!({"paused": false})));
    assert!(
        h.frame(id, 0, seq, &bytes[off..]),
        "the 536-byte last chunk is charged exactly"
    );
    assert!(h.b.is_live(id));
    assert_eq!(h.b.retained_bytes(), budget as u64);
}

#[test]
fn grants_are_batched_one_per_half_window() {
    let mut h = H::new();
    let id = h.gallery(4096);
    h.text(blob_start(id, 0, None, "image/jpeg"));
    for seq in 0..4096u32 {
        assert!(h.frame(id, 0, seq, &[(seq & 0xff) as u8]));
    }
    assert_eq!(h.grants(id), vec![2048, 2048]);
}

#[test]
fn payload_lands_in_one_buffer_per_channel_intact() {
    let mut h = H::new();
    let id = h.gallery(65536);
    let bytes: Vec<u8> = (0..10_000).map(|i| ((i * 31) & 0xff) as u8).collect();
    h.text(blob_start(id, 0, Some(bytes.len() as u64), "image/jpeg"));
    for (seq, chunk) in bytes.chunks(1500).enumerate() {
        assert!(h.frame(id, 0, seq as u32, chunk));
    }
    h.text(result(id, gallery_items(&[item(0, "image/jpeg", &bytes)])));
    match h.settled(id).unwrap() {
        Outcome::Ok { blobs, .. } => assert_eq!(blobs[0].bytes, bytes),
        o => panic!("{o:?}"),
    }
}

#[test]
fn an_aggregate_pool_bounds_connections_together() {
    let pool = RetainedBytesPool::new(100 * KIB as u64);
    let mut ca = config();
    ca.pool = Some(pool.clone());
    let mut cb = config();
    cb.pool = Some(pool.clone());
    let mut a = H::with(ca);
    let mut b = H::with(cb);
    let ha = a.gallery(65536);
    let hb = b.gallery(65536);
    a.text(blob_start(ha, 0, Some(80 * KIB as u64), "image/jpeg"));
    assert!(a.b.is_live(ha));
    assert_eq!(pool.in_use(), 80 * KIB as u64);
    b.text(blob_start(hb, 0, Some(40 * KIB as u64), "image/jpeg"));
    assert_eq!(b.code(hb), Some(E::Throttled));
    a.b.cancel(ha, a.now);
    a.drain();
    assert_eq!(pool.in_use(), 0);
    assert!(pool.try_reserve(100 * KIB as u64));
    assert!(!pool.try_reserve(1));
    pool.release(100 * KIB as u64);
}

#[test]
fn bad_frame_headers_are_connection_level_and_the_request_lives_on() {
    let mut h = H::new();
    let id = h.gallery(65536);
    h.text(blob_start(id, 0, Some(3), "image/jpeg"));
    let mut bad = frame(id, 0, 0, &[1, 2, 3]);
    bad[0] = 2;
    assert!(!h.b.on_frame(&bad, h.now));
    bad[0] = 1;
    bad[1] = 1;
    assert!(!h.b.on_frame(&bad, h.now));
    assert!(
        !h.b.on_frame(&bad[..11], h.now),
        "short frames are dropped silently"
    );
    assert_eq!(h.b.connection_violations(), 2);
    assert!(h.b.last_connection_violation().unwrap().contains("flags 1"));
    assert!(h.b.is_live(id));
    assert!(h.frame(id, 0, 0, &[1, 2, 3]));
}

#[test]
fn held_results_count_until_released() {
    let mut h = H::new();
    let mut spec = h.spec("gallery.pick", gallery_params(1));
    spec.hold_result = true;
    let id = h.open(spec).unwrap();
    h.text(blob_start(id, 0, Some(10), "image/jpeg"));
    h.frame(id, 0, 0, &[1; 10]);
    h.text(result(
        id,
        gallery_items(&[item(0, "image/jpeg", &[1; 10])]),
    ));
    assert!(matches!(
        h.settled(id),
        Some(Outcome::Ok { held: true, .. })
    ));
    assert!(
        h.b.retained_bytes() >= 10,
        "completed-but-unconsumed results count"
    );
    h.b.release_result(id);
    assert_eq!(h.b.retained_bytes(), 0);
    h.b.release_result(id);
    assert_eq!(h.b.retained_bytes(), 0, "idempotent");

    let mut spec = h.spec("gallery.pick", gallery_params(1));
    spec.hold_result = true;
    let id = h.open(spec).unwrap();
    h.text(blob_start(id, 0, Some(10), "image/jpeg"));
    h.frame(id, 0, 0, &[1; 10]);
    h.text(result(
        id,
        gallery_items(&[item(0, "image/jpeg", &[1; 10])]),
    ));
    assert!(h.b.retained_bytes() > 0);
    h.b.close(E::ConnectionLost);
    assert_eq!(h.b.retained_bytes(), 0, "close releases held results");
}

// ---------------------------------------------------------------------------
// downloads (file.save)
// ---------------------------------------------------------------------------

fn save(h: &mut H, bytes: Vec<u8>) -> u32 {
    h.open(OpenSpec::save("report.txt", "text/plain", bytes, "m1", 1))
        .expect("file.save opens")
}

#[test]
fn nothing_is_sent_before_the_client_grants() {
    let mut h = H::new();
    let bytes = b"hypen-saved".to_vec();
    let id = save(&mut h, bytes.clone());
    let req = h.requests("file.save")[0].clone();
    assert_eq!(
        req["initialCredit"], 0,
        "server → client planes start at zero"
    );
    assert_eq!(
        req["params"],
        file_save_params("report.txt", "text/plain", &bytes)
    );
    assert!(h.frames().is_empty());
    h.text(control(id, json!({"grant": 65536})));
    let frames = h.frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0], frame(id, 0, 0, &bytes));
    h.text(result(id, json!({"bytesWritten": 11})));
    assert!(h.settled(id).unwrap().is_ok());
}

#[test]
fn the_broker_never_hands_out_more_than_the_granted_amount() {
    let mut h = H::new();
    let bytes: Vec<u8> = (0..200 * KIB).map(|i| i as u8).collect();
    let id = save(&mut h, bytes.clone());
    h.text(control(id, json!({"grant": 1000})));
    assert_eq!(
        h.frames()
            .iter()
            .map(|f| payload_len(f))
            .collect::<Vec<_>>(),
        vec![1000]
    );
    h.text(control(id, json!({"grant": 100 * KIB})));
    assert_eq!(
        h.frames()
            .iter()
            .map(|f| payload_len(f))
            .collect::<Vec<_>>(),
        vec![1000, 64 * KIB, 100 * KIB - 64 * KIB]
    );
    let sent: Vec<u8> = h.frames().iter().flat_map(|f| f[12..].to_vec()).collect();
    assert_eq!(sent, bytes[..1000 + 100 * KIB], "in order, from the start");
}

#[test]
fn a_grant_overflowing_max_outstanding_credit_is_a_violation() {
    let mut h = H::new();
    let id = save(&mut h, vec![1; 10]);
    h.text(control(id, json!({"grant": 8 * MIB + 1})));
    assert_eq!(h.code(id), Some(E::InvalidParams));
    assert_eq!(h.cancels(id), 1);
}

#[test]
fn a_receipt_is_judged_against_bytes_that_really_left() {
    // Success before the frames were handed to the transport.
    let mut h = H::new();
    let id = save(&mut h, b"hypen-saved".to_vec());
    h.b.on_text(&control(id, json!({"grant": 64})).to_string(), h.now);
    h.b.on_text(&result(id, json!({"bytesWritten": 11})).to_string(), h.now);
    h.drain();
    assert!(h
        .detail(id)
        .contains("success after 0 of 11 bytes were sent"));
    assert!(
        h.frames().is_empty(),
        "queued bulk of a retired id is discarded"
    );
    assert_eq!(h.b.queued_bulk_bytes(), 0);
    // A receipt for the wrong byte count.
    let mut h = H::new();
    let id = save(&mut h, b"hypen-saved".to_vec());
    h.text(control(id, json!({"grant": 64})));
    h.text(result(id, json!({"bytesWritten": 5})));
    assert!(h.detail(id).contains("bytesWritten 5 ≠ declared 11"));
}

#[test]
fn download_announcements_are_validated_locally() {
    let mut h = H::new();
    let empty = h
        .open(OpenSpec::save("a", "a/b", vec![], "m1", 1))
        .unwrap_err();
    assert_eq!(empty.code, E::InvalidParams);
    let mut forged = OpenSpec::save("a", "a/b", b"abc".to_vec(), "m1", 1);
    forged.params["sha256"] = json!(sha256_hex(b"abd"));
    assert_eq!(
        h.open(forged).unwrap_err().detail.as_deref(),
        Some("params.sha256 does not match the download")
    );
    let mut short = OpenSpec::save("a", "a/b", b"abc".to_vec(), "m1", 1);
    short.params["bytes"] = json!(2);
    assert_eq!(h.open(short).unwrap_err().code, E::InvalidParams);
    let mut long_name = OpenSpec::save(&"n".repeat(513), "a/b", b"abc".to_vec(), "m1", 1);
    long_name.hold_result = false;
    assert_eq!(h.open(long_name).unwrap_err().code, E::InvalidParams);
    let no_bytes = h
        .open(h.spec("file.save", file_save_params("a", "a/b", b"abc")))
        .unwrap_err();
    assert!(no_bytes.detail.unwrap().contains("use save()"));
    let mut wrong = h.spec("gallery.pick", gallery_params(1));
    wrong.download = Some(vec![1]);
    assert_eq!(h.open(wrong).unwrap_err().code, E::InvalidParams);
    assert!(h.requests("file.save").is_empty());
}

#[test]
fn a_client_that_never_grants_receives_nothing_and_the_deadline_applies() {
    let mut h = H::new();
    let mut spec = OpenSpec::save("a", "a/b", vec![1; 10], "m1", 1);
    spec.timeout_ms = Some(60_000);
    let id = h.open(spec).unwrap();
    for _ in 0..12 {
        let seq = h.renewals(id).last().unwrap().0;
        h.text(control(id, json!({"leaseAck": seq})));
        h.advance(5_000);
    }
    assert!(h.frames().is_empty());
    assert_eq!(h.code(id), Some(E::Timeout));
}

#[test]
fn cancelling_a_download_discards_its_queued_frames() {
    let mut h = H::new();
    let id = save(&mut h, vec![5; 200 * KIB]);
    h.b.on_text(&control(id, json!({"grant": 200 * KIB})).to_string(), h.now);
    assert!(h.b.queued_bulk_bytes() > 0);
    h.b.cancel(id, h.now);
    assert_eq!(h.b.queued_bulk_bytes(), 0);
    h.drain();
    assert!(h.frames().is_empty());
    assert_eq!(h.code(id), Some(E::Cancelled));
}

#[test]
fn the_bulk_queue_bound_cancels_throttled() {
    let mut cfg = config();
    cfg.scheduler.max_queued_bytes = 100 * KIB;
    let mut h = H::with(cfg);
    let id = save(&mut h, vec![5; 200 * KIB]);
    h.b.on_text(&control(id, json!({"grant": 200 * KIB})).to_string(), h.now);
    h.drain();
    assert_eq!(h.code(id), Some(E::Throttled));
    assert_eq!(h.detail(id), "bulk queue bound reached");
    assert_eq!(h.b.queued_bulk_bytes(), 0);
}

// ---------------------------------------------------------------------------
// transport scheduling (§2.3)
// ---------------------------------------------------------------------------

fn fr(id: u32, seq: u32, len: usize) -> Vec<u8> {
    frame(id, 0, seq, &vec![0; len])
}

#[test]
fn scheduler_turns_are_bounded_round_robin_and_fifo() {
    let mut s = BulkScheduler::new(SchedulerConfig::default());
    for i in 0..3 {
        assert!(s.enqueue(1, fr(1, i, 64 * KIB)));
    }
    for i in 0..2 {
        assert!(s.enqueue(2, fr(2, i, 64 * KIB)));
    }
    let mut order = Vec::new();
    while s.has_pending() {
        let turn = s.turn(0);
        assert_eq!(turn.len(), 1, "one 64 KiB frame per turn");
        order.extend(
            turn.into_iter()
                .map(|(id, f)| (id, u32::from_le_bytes([f[8], f[9], f[10], f[11]]))),
        );
    }
    assert_eq!(order, vec![(1, 0), (2, 0), (1, 1), (2, 1), (1, 2)]);
    assert_eq!(s.turns(), 5);
}

#[test]
fn small_frames_are_batched_up_to_the_turn_budget() {
    let mut s = BulkScheduler::new(SchedulerConfig::default());
    for i in 0..10 {
        s.enqueue(1, fr(1, i, 10 * KIB));
    }
    assert_eq!(s.turn(0).len(), 6, "60 KiB ≤ 64 KiB; a 7th would exceed it");
    assert_eq!(s.turn(0).len(), 4);
}

#[test]
fn nothing_goes_to_a_saturated_transport() {
    let mut s = BulkScheduler::new(SchedulerConfig::default());
    s.enqueue(1, fr(1, 0, 64 * KIB));
    s.enqueue(1, fr(1, 1, 64 * KIB));
    assert!(s.turn(300 * KIB).is_empty());
    assert!(s.saturated(256 * KIB));
    assert_eq!(s.turn(256 * KIB - 1).len(), 1);
    assert!(s.turn(256 * KIB).is_empty());
    // Within a turn, handed-out frames count toward the transport buffer.
    let mut s = BulkScheduler::new(SchedulerConfig {
        turn_bytes: 10 * MIB,
        ..SchedulerConfig::default()
    });
    for i in 0..10 {
        s.enqueue(1, fr(1, i, 64 * KIB));
    }
    assert_eq!(s.turn(0).len(), 4, "stops once 256 KiB are pending");
}

#[test]
fn the_queue_is_finite_and_discard_frees_it() {
    let mut s = BulkScheduler::new(SchedulerConfig {
        max_queued_bytes: 100 * KIB,
        ..SchedulerConfig::default()
    });
    assert!(s.enqueue(1, fr(1, 0, 64 * KIB)));
    assert!(!s.enqueue(1, fr(1, 1, 64 * KIB)));
    assert_eq!(s.queued_bytes(), 64 * KIB + 12);
    s.discard(1);
    assert_eq!(s.queued_bytes(), 0);
    assert!(s.enqueue(2, fr(2, 0, 64 * KIB)));
}

#[test]
fn discard_between_turns_keeps_round_robin_for_the_rest() {
    let mut s = BulkScheduler::new(SchedulerConfig {
        turn_bytes: MIB,
        ..SchedulerConfig::default()
    });
    for seq in 0..3 {
        for id in 1..=3 {
            s.enqueue(id, fr(id, seq, 100));
        }
    }
    let first = s.turn(0);
    assert_eq!(first.len(), 9);
    let mut s = BulkScheduler::new(SchedulerConfig::default());
    for seq in 0..3 {
        for id in 1..=3 {
            s.enqueue(id, fr(id, seq, 30 * KIB));
        }
    }
    let t1: Vec<u32> = s.turn(0).into_iter().map(|(id, _)| id).collect();
    assert_eq!(t1, vec![1, 2]);
    s.discard(1);
    s.discard(2);
    let mut rest = Vec::new();
    while s.has_pending() {
        rest.extend(s.turn(0).into_iter().map(|(id, _)| id));
    }
    assert_eq!(rest, vec![3, 3, 3]);
    assert_eq!(s.queued_bytes(), 0);
    s.close();
    assert!(!s.enqueue(1, fr(1, 0, 1)));
}

#[test]
fn a_slow_transport_blocks_bulk_while_control_and_requests_still_go_out() {
    let mut h = H::new();
    let id = save(&mut h, vec![7; 300 * KIB]);
    h.b.set_transport_buffered(300 * KIB);
    h.text(control(id, json!({"grant": 300 * KIB})));
    assert!(h.frames().is_empty(), "no bulk to a saturated transport");
    let deadline = h.b.next_deadline().unwrap();
    assert!(
        deadline > h.now && deadline <= h.now + 10,
        "re-checked shortly"
    );
    let other = h.permission();
    assert_eq!(
        h.requests("permission.request")[0]["id"],
        other,
        "requests are never queued behind bulk"
    );
    h.b.set_transport_buffered(0);
    assert_eq!(h.b.next_deadline(), Some(h.now), "bulk due at once");
    let turn: Vec<usize> =
        h.b.poll()
            .iter()
            .filter_map(|o| match o {
                hypen_engine::device::Output::SendFrame(f) => Some(payload_len(f)),
                _ => None,
            })
            .collect();
    assert_eq!(
        turn,
        vec![64 * KIB],
        "one ≤ 64 KiB turn per poll: UI traffic goes between"
    );
    h.drain();
    let total: usize = h.frames().iter().map(|f| payload_len(f)).sum::<usize>() + 64 * KIB;
    assert_eq!(total, 300 * KIB);
    assert!(h.b.bulk_turns() >= 5);
}

#[test]
fn downloads_share_the_transport_round_robin() {
    let mut h = H::new();
    let a = save(&mut h, vec![1; 128 * KIB]);
    let b = h
        .open(OpenSpec::save(
            "b.txt",
            "text/plain",
            vec![2; 128 * KIB],
            "m1",
            1,
        ))
        .unwrap();
    h.b.on_text(&control(a, json!({"grant": 128 * KIB})).to_string(), h.now);
    h.b.on_text(&control(b, json!({"grant": 128 * KIB})).to_string(), h.now);
    h.drain();
    let ids: Vec<u32> = h.frames().iter().map(|f| frame_request_id(f)).collect();
    assert_eq!(ids, vec![a, b, a, b]);
    h.text(result(a, json!({"bytesWritten": 128 * KIB})));
    h.text(result(b, json!({"bytesWritten": 128 * KIB})));
    assert!(h.settled(a).unwrap().is_ok() && h.settled(b).unwrap().is_ok());
}

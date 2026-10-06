//! Device Capability Protocol runtime (RFC 001) — the server-side broker.
//!
//! The wire types, strict decoders, registry and handshake selection live in
//! [`crate::serialize::device`]; this module is the one protocol state
//! machine every server SDK runs on top of (TypeScript through the WASM
//! bindings, Go through WASI, Kotlin and the Swift server through UniFFI).
//! It is sans-IO: no sockets, threads, clocks or randomness — see
//! [`DeviceBroker`].

pub mod broker;
pub mod scheduler;

pub use broker::{
    device_message_type, file_save_params, is_oversize_device_text, negotiate, negotiate_explained,
    server_advertisement, server_consumes, sha256_hex, top_level_member_text, Blob, BrokerConfig,
    DeviceBroker, EventRate, LocalRefusal, OpenSpec, Outcome, Output, RetainedBytesPool,
    RevisionOverride, ViolationRate, CONNECTION_VIOLATIONS_PER_SEC, CONNECTION_VIOLATION_BURST,
    CONTROL_STREAM_INITIAL_CREDIT, CONTROL_STREAM_REOPEN_LEAD_MS, CONTROL_STREAM_TIMEOUT_MS,
    DEFAULT_MAX_RETAINED_BYTES, DEFAULT_PROCESS_RETAINED_BYTES, DEFAULT_STREAM_INITIAL_CREDIT,
    DEFAULT_TIMEOUT_MS, DEFAULT_UPLOAD_INITIAL_CREDIT, DEVICE_PLANE_CLOSE_CODE,
    DO_AGGREGATE_RETAINED_BYTES, DO_MAX_RETAINED_BYTES, LEASE_MAX_UNACKED_RENEWALS,
    MAX_BACKGROUND_PINNED_MODULES, MIN_FRAME_CHARGE_BYTES, STREAM_DRAIN_TIMEOUT_MS,
    STREAM_EVENTS_PER_CONNECTION_BURST, STREAM_EVENTS_PER_CONNECTION_PER_SEC,
    STREAM_EVENTS_PER_REQUEST_BURST, STREAM_EVENTS_PER_REQUEST_PER_SEC,
};
pub use scheduler::{BulkScheduler, SchedulerConfig, MAX_QUEUED_BULK_BYTES, SCHEDULER_RETRY_MS};

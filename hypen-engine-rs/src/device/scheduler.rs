//! Bulk transport scheduler for server → client device frames (RFC 001
//! §2.3 "Transport scheduling is required, not implied by small frames").
//!
//! Sans-IO: the broker queues frames here and hands them out one scheduling
//! *turn* at a time from [`super::DeviceBroker::poll`]. Priority is
//! structural:
//!
//! 1. control / lease / request JSON leaves through the broker's text
//!    outputs, never queued behind bulk;
//! 2. UI messages are sent by the host between polls — every bulk turn is a
//!    separate poll, so ready UI work always goes out before the next chunk;
//! 3. bulk binary frames are queued here per request and drained in turns:
//!    at most `turn_bytes` (64 KiB) of payload per turn, round-robin across
//!    requests, FIFO within one, and nothing while the transport reports at
//!    least `pending_limit` (256 KiB) of buffered bytes.
//!
//! The queue is finite (`max_queued_bytes`, 8 MiB): [`BulkScheduler::enqueue`]
//! refuses a frame that would exceed it, so the broker cancels the offending
//! request (`throttled`) instead of growing memory.

use std::collections::{HashMap, VecDeque};

use crate::serialize::device::{
    FRAME_HEADER_LEN, MAX_BULK_CHUNK_BYTES, MAX_TRANSPORT_PENDING_BYTES,
};

/// Finite bound on bulk bytes (whole frames) queued per connection.
pub const MAX_QUEUED_BULK_BYTES: usize = 8 * 1024 * 1024;
/// Re-check delay while the transport is saturated, milliseconds.
pub const SCHEDULER_RETRY_MS: u64 = 10;

/// Scheduler tuning. Defaults are the RFC 001 §2.3 values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulerConfig {
    /// Payload bytes handed to the transport per scheduling turn.
    pub turn_bytes: usize,
    /// Hand out nothing while the transport reports this many buffered bytes.
    pub pending_limit: usize,
    /// Finite bound on queued bulk bytes (whole frames, header included).
    pub max_queued_bytes: usize,
    /// Re-check delay while the transport is saturated, milliseconds.
    pub retry_ms: u64,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        SchedulerConfig {
            turn_bytes: MAX_BULK_CHUNK_BYTES,
            pending_limit: MAX_TRANSPORT_PENDING_BYTES,
            max_queued_bytes: MAX_QUEUED_BULK_BYTES,
            retry_ms: SCHEDULER_RETRY_MS,
        }
    }
}

/// Per-connection bulk queue with round-robin turns.
#[derive(Debug, Default)]
pub struct BulkScheduler {
    config: SchedulerConfig,
    queues: HashMap<u32, VecDeque<Vec<u8>>>,
    /// Round-robin order of request ids with queued frames.
    order: Vec<u32>,
    cursor: usize,
    queued: usize,
    closed: bool,
    turns: u64,
}

impl BulkScheduler {
    pub fn new(config: SchedulerConfig) -> Self {
        BulkScheduler {
            config,
            ..Default::default()
        }
    }

    pub fn config(&self) -> SchedulerConfig {
        self.config
    }

    /// Total bulk bytes (whole frames) currently queued.
    pub fn queued_bytes(&self) -> usize {
        self.queued
    }

    /// Whether any frame waits for a turn.
    pub fn has_pending(&self) -> bool {
        !self.closed && self.queued > 0 && !self.order.is_empty()
    }

    /// Turns that handed out at least one frame (diagnostics/tests).
    pub fn turns(&self) -> u64 {
        self.turns
    }

    /// Whether a transport reporting `buffered` bytes is saturated.
    pub fn saturated(&self, buffered: usize) -> bool {
        buffered >= self.config.pending_limit
    }

    /// Queue one frame for `request_id`. Returns false — queuing nothing —
    /// when the frame would push the queue past its finite bound.
    pub fn enqueue(&mut self, request_id: u32, frame: Vec<u8>) -> bool {
        if self.closed || self.queued + frame.len() > self.config.max_queued_bytes {
            return false;
        }
        self.queued += frame.len();
        let q = self.queues.entry(request_id).or_default();
        if q.is_empty() && !self.order.contains(&request_id) {
            self.order.push(request_id);
        }
        q.push_back(frame);
        true
    }

    /// Drop every queued frame of a request (cancellation / settlement).
    pub fn discard(&mut self, request_id: u32) {
        let Some(q) = self.queues.remove(&request_id) else {
            return;
        };
        self.queued -= q.iter().map(Vec::len).sum::<usize>();
        if let Some(idx) = self.order.iter().position(|&id| id == request_id) {
            self.order.remove(idx);
            if self.cursor > idx {
                self.cursor -= 1;
            }
        }
    }

    /// Stop and drop everything (connection teardown).
    pub fn close(&mut self) {
        self.closed = true;
        self.queues.clear();
        self.order.clear();
        self.cursor = 0;
        self.queued = 0;
    }

    /// One scheduling turn against a transport currently reporting
    /// `buffered` bytes: at most `turn_bytes` of payload (a single larger
    /// frame is still handed out alone), round-robin across requests, and
    /// nothing once the transport reaches `pending_limit` — every frame
    /// handed out in this turn counts toward the transport's buffer.
    /// Returns `(request_id, frame)` pairs in send order.
    pub fn turn(&mut self, buffered: usize) -> Vec<(u32, Vec<u8>)> {
        let mut out = Vec::new();
        if self.closed {
            return out;
        }
        let mut pending = buffered;
        let mut handed = 0usize;
        while !self.order.is_empty() {
            if pending >= self.config.pending_limit {
                break;
            }
            if self.cursor >= self.order.len() {
                self.cursor = 0;
            }
            let id = self.order[self.cursor];
            let q = self.queues.get_mut(&id).expect("ordered id has a queue");
            let len = q.front().map(Vec::len).unwrap_or(0);
            let payload = len.saturating_sub(FRAME_HEADER_LEN);
            if !out.is_empty() && handed + payload > self.config.turn_bytes {
                break;
            }
            let frame = q.pop_front().expect("queued frame");
            self.queued -= frame.len();
            if q.is_empty() {
                self.queues.remove(&id);
                self.order.remove(self.cursor);
            } else {
                self.cursor += 1;
            }
            handed += payload;
            pending += frame.len();
            out.push((id, frame));
            if handed >= self.config.turn_bytes {
                break;
            }
        }
        if !out.is_empty() {
            self.turns += 1;
        }
        out
    }
}

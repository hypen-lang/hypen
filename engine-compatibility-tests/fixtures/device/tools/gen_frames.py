#!/usr/bin/env python3
"""Generates engine-compatibility-tests/fixtures/device/frames.json.

Golden 12-byte little-endian frame headers (RFC 001 §2.3), invalid frames
with their classification, and the receiver-side per-channel `seq` cases.
The Rust reference codec (`FrameHeader` in hypen-engine-rs/src/serialize/
device.rs) must decode every golden exactly; its tests check it.
"""
import json
import os
import struct

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frames.json")
U32_MAX = 4294967295


def enc(version, flags, channel, request_id, seq):
    return struct.pack("<BBHII", version, flags, channel, request_id, seq)


def golden(channel, request_id, seq, payload=None):
    frame = {"header": {"version": 1, "flags": 0, "channel": channel, "requestId": request_id, "seq": seq},
             "hex": (enc(1, 0, channel, request_id, seq) + (payload or b"")).hex()}
    if payload is not None:
        frame["payloadHex"] = payload.hex()
    return frame


VALID = enc(1, 0, 0, 1, 0)

frames = {
    "description": (
        "Golden binary frame headers (12-byte little-endian). Per-SDK native codecs must reproduce "
        "these bytes exactly; the Rust reference codec in hypen-engine-rs/src/serialize/device.rs "
        "generated them. The header-only goldens are codec vectors: on the wire a frame with a "
        "zero-length payload is always a receiver-side `blob` violation (a zero-byte item sends no "
        "frames, decision D2). `invalid` frames: `shortHeader` (under 12 bytes) is dropped without "
        "effect; `violation-*` (unknown version or nonzero flags) is a connection-level `malformed` "
        "violation: discarded and counted, never terminating the request its untrusted header names "
        "(decision D3)."
    ),
    "frames": [
        golden(0, 1, 0),
        golden(3, 17, 2),
        golden(65535, U32_MAX, U32_MAX),
        golden(0, 1, 0, b"hello-hypen-photo"),
    ],
    "invalid": [
        {"reason": "shortHeader", "hex": VALID[:11].hex()},
        {"reason": "violation-version", "hex": enc(9, 0, 0, 1, 0).hex()},
        {"reason": "violation-flags", "hex": enc(1, 1, 0, 1, 0).hex()},
        {"reason": "shortHeader", "hex": ""},
        {"reason": "shortHeader", "hex": "01"},
        {"reason": "violation-version", "hex": enc(0, 0, 0, 1, 0).hex()},
        {"reason": "violation-version", "hex": enc(2, 0, 0, 1, 0).hex()},
        {"reason": "violation-flags", "hex": enc(1, 0xFF, 0, 1, 0).hex()},
        {"reason": "violation-version", "hex": (enc(0xFF, 0, 0, 1, 0) + bytes.fromhex("deadbeef")).hex()},
    ],
    "sequences": {
        "description": (
            "Receiver-side per-(requestId, channel) sequence rule (RFC 001 §2.3), independent of the "
            "stateless header codec. Feed `seqs` in order to a fresh channel tracker for a revision with "
            "the given `overflow` policy; `valid` says whether every seq is accepted (false: the last one "
            "is the violation). seq starts at 0 and advances for every produced chunk, including dropped "
            "ones: `pause` (lossless) requires exactly the next seq; `dropOldest` permits forward gaps. "
            "Repeats, decreases and any wrap past 2^32-1 are violations. (A lossless channel cannot reach "
            "2^32-1 from a fresh tracker here; the Rust unit test lossless_sequence_up_to_u32_max_and_no_wrap "
            "pins that boundary.)"
        ),
        "cases": [
            {"name": "contiguous-from-zero", "overflow": "pause", "seqs": [0, 1, 2], "valid": True},
            {"name": "not-starting-at-zero-lossless", "overflow": "pause", "seqs": [1], "valid": False},
            {"name": "gap-on-lossless", "overflow": "pause", "seqs": [0, 2], "valid": False},
            {"name": "repeat-on-lossless", "overflow": "pause", "seqs": [0, 1, 1], "valid": False},
            {"name": "decrease-on-lossless", "overflow": "pause", "seqs": [0, 1, 0], "valid": False},
            {"name": "gap-on-drop-oldest", "overflow": "dropOldest", "seqs": [0, 3, 4], "valid": True},
            {"name": "drop-oldest-first-chunks-dropped", "overflow": "dropOldest", "seqs": [2, 3], "valid": True},
            {"name": "repeat-on-drop-oldest", "overflow": "dropOldest", "seqs": [0, 0], "valid": False},
            {"name": "decrease-on-drop-oldest", "overflow": "dropOldest", "seqs": [0, 5, 4], "valid": False},
            {"name": "reaches-u32-max", "overflow": "dropOldest", "seqs": [U32_MAX - 1, U32_MAX], "valid": True},
            {"name": "wrap-after-u32-max", "overflow": "dropOldest", "seqs": [U32_MAX, 0], "valid": False},
            {"name": "any-seq-after-u32-max", "overflow": "dropOldest", "seqs": [U32_MAX, U32_MAX], "valid": False},
        ],
    },
}

with open(OUT, "w", encoding="utf-8") as f:
    f.write(json.dumps(frames, indent=2, ensure_ascii=False) + "\n")
print("frames.json:", len(frames["frames"]), "goldens,", len(frames["invalid"]), "invalid,",
      len(frames["sequences"]["cases"]), "sequence cases")

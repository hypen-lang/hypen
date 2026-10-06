# RFC 001: Device Capability Protocol

**Scope:** the Remote UI protocol extension through which server-side module handlers
use device capabilities of the connected client.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as
described in RFC 2119.

## 1. Overview

A **server** runs Hypen modules; a **client** renders their UI over a Remote UI
connection. A module handler on the server asks the client to perform a **device
operation** (pick a photo, pick or save a file, capture from the camera, record the
microphone, scan for or select a Bluetooth device, query or request a permission).
The client's **DeviceHost** executes it, owns consent and platform UI, and returns
the result. The renderer is not involved: it consumes patches only.

Terms:

- **Capability**: a named device operation (`gallery.pick`). A capability exposes
  hardware, OS services or user-mediated operations the server cannot perform itself.
  It is not analytics, app messaging or a general RPC channel. `core.*` names are
  reserved for protocol control.
- **Revision**: an immutable, numbered version of a capability's schemas and policy
  (`gallery.pick@1`).
- **Registry**: the set of revisions an endpoint implements, with each revision's
  mode, data plane, consent, allowed lifetimes, limits and schemas.
- **Device plane**: the negotiated device part of one physical connection.
- **Broker**: the server-side state machine of the device plane (§4).
- **Owner**: the module instance activation (or the connection) a request belongs to.

A device request has no relationship to a UI element. It may originate in an action
handler, a lifecycle handler, or other session-owned work, and carries no node id,
gesture token or originating-action id. When a platform requires a fresh user gesture,
the DeviceHost presents its own interaction (§2.6).

Principles (referenced as §1.1–§1.11):

1. **Three envelope messages**: `deviceRequest`, `deviceResponse`, `deviceEvent`.
   Control variants have explicit schemas and state transitions.
2. **The registry defines capability policy.** Schemas, modes, consent, allowed
   lifetimes, limits and platform activation requirements belong to the revision.
   Request identity, owner, selected revision and lifetime travel on the wire. SDK
   types and validators are generated from the registry's exported JSON Schemas
   (`engine-compatibility-tests/schema/device/`).
3. **The DeviceHost owns consent and activation.** Fresh gestures come from
   host-owned controls, never from intercepting app interactions. Platform gesture
   requirements and user consent are separate.
4. **Exact revisions are selected.** Clients and servers need not implement the same
   registry. Each request names the exact revision it uses for its whole lifetime.
5. **Ownership is explicit and independent of rendering.** The server owns module
   lifecycles and cancels their work. The DeviceHost enforces received cancellations,
   local policy and finite leases.
6. **Device work is connection-scoped.** Request ids are never reused on a
   connection. Loss of broker state closes the connection. Resuming app state never
   resumes device operations. Ids correlate messages; they do not authenticate.
7. **Replay cannot initiate device work.** A dispatch replayed or broadcast onto
   another session (`syncActions`, broadcast) runs with replay provenance; any device
   request it makes fails locally with `unavailable` (`syncActions.replay`). Only a
   dispatch sent by the connection's own client can start device work. Device
   messages use a dedicated route that `broadcast()` and `syncActions` never carry.
8. **Client policy is authoritative.** Authenticated origin, consent, cooldowns, size
   limits and stream indicators are enforced on the client. Server claims never
   establish an OS permission or a user grant.
9. **Device results are untrusted input.** Both endpoints validate against the
   selected schemas and enforce resource limits. A hash verifies bytes against a
   declaration; it does not make the content or the client trustworthy.
10. **Credit and liveness are separate.** Credit limits data; lease renewals keep
    requests alive when no data flows. Transport queues are bounded and scheduled so
    bulk data never monopolizes UI and control traffic.
11. **Fakes are explicit.** A fake DeviceHost (`@hypen-space/device-fake`) is a
    separate development package, refuses production initialization, marks every
    result `simulated: true` and shows a visible banner.

Out of scope: resuming a transfer across connections, recovering a broker in place,
out-of-band (HTTP/CDN) media transfer, and general `app.custom.*` RPC.

## 2. Wire protocol

### 2.1 Envelope and request state

```jsonc
// server → client: open a module-owned operation
{"type":"deviceRequest","id":17,"capability":"gallery.pick","version":1,
 "owner":{"moduleInstanceId":"profile-7","activationId":3},
 "lifetime":"activation","timeoutMs":300000,"initialCredit":65536,
 "params":{"mediaTypes":["photo"],"maxCount":1}}

// client → server: terminal success OR error, never both
{"type":"deviceResponse","id":17,"result":{"items":[
 {"channel":0,"contentType":"image/jpeg","bytes":120000,
  "sha256":"b6efbb3f92282c44cd7d780e66ff2b52e6dfe7f5b9f422fd26e9b960b50e8974"}]}}
{"type":"deviceResponse","id":17,
 "error":{"code":"denied","platformDetail":"user-declined"}}

// client → server: capability-defined events, including blob metadata
// (`bytes` is optional: present = exact declaration, absent = unknown length, §2.4)
{"type":"deviceEvent","id":17,
 "event":{"kind":"blobStart","channel":0,"contentType":"image/jpeg","bytes":120000}}
// client → server: optional progress, allowed on every revision
{"type":"deviceEvent","id":17,"event":{"kind":"progress","state":"pendingConsent"}}

// receiver → sender: additive credit for the whole request
{"type":"deviceEvent","id":17,"control":{"grant":65536}}
// server → client: cancellation or lease renewal
{"type":"deviceEvent","id":17,"control":{"cancel":true}}
{"type":"deviceEvent","id":17,"control":{"renewLease":1}}
// client → server: acknowledges the exact lease sequence
{"type":"deviceEvent","id":17,"control":{"leaseAck":1}}
// data sender → receiver: backpressure status
{"type":"deviceEvent","id":17,"control":{"paused":true}}
```

Mode, credit unit, channel directions and allowed policies come from the selected
revision. `owner`, `lifetime`, `version`, `timeoutMs` and `initialCredit` are
per-request data; the receiver MUST validate them against the selected revision.

- **Allocation.** The server assigns increasing `u32` ids from 1. An id is never
  reused on the physical connection, including for rejected and completed requests.
  Requests are sent in id order. Zero is reserved. Before the id space is exhausted
  the server closes the connection. The client tracks a high-water mark and ignores
  duplicate and older requests. Ids are not secrets or authorization; routing is
  scoped to the authenticated connection.
- **Unknown and stale ids.** Responses, events, controls and binary frames for an id
  that is not live for the receiver are ignored, whatever their direction or validity.
  Liveness is checked before direction; a message for an unknown or retired id is
  never a violation. Diagnostics are rate-limited. A duplicate request is dropped
  without executing it again. Malformed data is never reinterpreted as a different
  capability or revision.
- **Violation reactions.** A *known-id invalid message* is a message for a live id
  that is sent in the wrong direction, fails its schema, or breaks the request's
  credit, lease, sequence, blob, progress or owner rules. It terminates that operation
  with `invalidParams`: a detecting client sends that terminal error; a detecting
  server sends `cancel` and fails locally with that error (when the offending message
  is the client's own terminal, the server only fails locally). A `deviceResponse`
  from the server on a live id is such a message. A request for a revision that is not
  declared or not in the live selection is refused with `unsupported`.
- **Attribution.** Text that breaks the JSON limits below, and a frame whose header
  has an unknown version or nonzero flags (§2.3), is attributable to no request: it is
  a connection-level violation, discarded and counted, and never terminates the
  request its id appears to name. A message within the limits is attributed only by a
  device `type` and an integer `id` in 1..2^32−1. An endpoint MAY close the connection
  after repeated violations of either kind. The shared transcripts
  (`engine-compatibility-tests/fixtures/device/`) pin every reaction.
- **State.** An admitted operation moves through `pendingConsent` (when needed),
  `running` and `terminal`. `paused` is a condition of a running transfer. An
  unsupported or invalid request MAY terminate immediately. A terminal operation never
  restarts, and progress never goes back: a `pendingConsent` progress event after
  `running` or after any data is a known-id invalid message.
- **Terminal authority.** Only the client sends `deviceResponse`, at most once per
  request. On a healthy connection every admitted operation ends with exactly one
  terminal response. Unary operations finish with one result; streams emit events or
  bytes and then one result or error. Errors and `simulated` status have
  protocol-level schemas shared by every capability.
- **Cancellation.** The server sends `control.cancel`, retires the id, discards data
  queued for it and settles locally without waiting. The client stops the work and
  responds `cancelled` unless it has already terminated. A client-initiated
  cancellation sends a terminal `cancelled` response; the server sends nothing in
  return. Races settle once; later messages are ignored. An OS dialog that cannot be
  dismissed MAY finish later, but its result MUST NOT restart or upload cancelled work.
- **Deadline.** `timeoutMs` is a positive bounded integer. The server starts its timer
  when it sends the request; the client uses `min(timeoutMs, localMaximum)` from
  receipt. When the server's timer fires first it sends `cancel`; when the client's
  fires first it responds `timeout`. Lease renewal never extends the deadline.
- **Events.** `progress` events (`{"kind":"progress","state":"pendingConsent"|
  "running"}`, client → server) are part of every revision's event union, consume no
  data credit and are optional to consume. `blobStart` and capability stream events
  are protocol data and MUST be processed according to the selected revision. `event`
  and `control` are mutually exclusive; a control contains exactly one variant.
- **Strict decoding.** Messages are closed objects with exact-case keys. `null` in
  place of an absent or typed member is invalid. An object is required where the
  schema says object (never an array or positional form) and a string where it says
  enum (never a one-key map), so re-encoding a decoded message reproduces the input.
  String bounds count Unicode code points. `simulated` and `cancel` are `true` when
  present. Every decoder enforces the following limits on every device message
  (envelope, `params`, `result`, `event`) and on the handshake objects of §2.2:

  | JSON limit | Value |
  |---|---|
  | Text size | at most 1,048,576 bytes of UTF-8, checked before parsing |
  | Nesting depth | at most 32 containers (`{` or `[`); the envelope object is depth 1; scalars do not count |
  | Numbers | integer tokens only, `-?(0\|[1-9][0-9]*)`: no fraction, exponent, `-0`, leading zero or `+`; at most 16 digits; magnitude at most 2^53−1 |
  | Strings (keys and values) | valid UTF-8; no raw control characters (< 0x20); no lone surrogate escapes; lengths in code points |
  | Keys | duplicates rejected at any depth, compared after unescaping (`"id"` = `"id"`) |
  | Literals | exactly `true`, `false`, `null`; no BOM, no trailing data |
  | Shapes | object where the schema says object, string where it says enum |

### 2.2 Handshake, revisions, and capability changes

The device extension adds optional members to the existing `hello` and `sessionAck`
messages and leaves all other UI messages unchanged:

```jsonc
// client → server: complete initial device advertisement
{"type":"hello","device":{"protocolVersions":[1],"binary":true,
 "capabilities":[{"name":"core.capabilities","versions":[1]},
                 {"name":"gallery.pick","versions":[1,2]}]}}
// server → client: the selection
{"type":"sessionAck","sessionId":"...","isNew":true,"isRestored":false,
 "device":{"protocolVersion":1,"binary":true,
 "capabilities":[{"name":"core.capabilities","version":1},
                 {"name":"gallery.pick","version":1}]}}
```

**Selection.** The server first validates `hello.device` against the JSON limits of
§2.1 and the handshake schema; a hello that fails validation disables the device plane
for the connection and is never repaired or partially used. Then:

- The highest mutually supported protocol version is selected, and for each
  capability the highest mutually supported revision that the server's registry
  declares.
- Version 0 is reserved and never selected, for protocol versions and revisions,
  including from the server's own lists.
- If `core.capabilities` revision 1 is not in the intersection, the device plane is
  disabled.
- `binary` is true only when both endpoints offer it and meet §2.5. When the
  negotiated `binary` is false, a revision whose data plane is binary (upload or
  download) is not selectable: the highest mutual revision without a binary data plane
  is selected, else the capability is omitted.
- A hello whose `capabilities` repeat a name, or whose `protocolVersions` or
  `versions` repeat a value, disables the device plane.
- Duplicate names in the server's own advertisement: the first entry wins. Duplicate
  names are invalid in `sessionAck.device` and in `core.capabilities` snapshots.
- Capability names compare by exact code points, never by Unicode canonical
  equivalence.
- An omitted device extension or no common protocol version disables the device
  plane; the connection works UI-only. No device traffic is sent before selection.

The shared corpus (`fixtures/device/conformance/selection.json`) pins these rules.

**Advertisement.** Clients advertise only capability names and revision numbers they
can implement, never device identifiers, hardware inventories or permission history.
Advertisement does not require a grant. Array sizes and revision counts are bounded.

**Requests and revisions.** Each request's `version` selects an exact revision from
the current live selection. Old revisions stay implemented while advertised: an
optional addition creates a new revision, and fields are never serialized into an
older revision. Parameters that need a newer revision fail locally with `unsupported`
when it is not selected; they are never dropped. A breaking semantic change uses a new
capability name.

**`core.capabilities`.** Every device plane supports `core.capabilities` revision 1,
a connection-owned stream:

- The server opens it once after selection, before any module can request device
  work. An app request before it, or a second core stream while one is live, closes
  the device plane.
- Its first event is the full current advertisement; each later event replaces the
  set. Events have shape `{event:{capabilities:[{name,versions}]}}` and cannot change
  the selected protocol or transport profile.
- It stays open across module navigation. The broker reopens it before its deadline;
  a reopened stream emits a fresh full snapshot, and the old stream is retired before
  the new stream's snapshot is accepted. A snapshot that omits `core.capabilities`
  does not end the stream.
- When event credit is exhausted, unsent updates coalesce into one latest snapshot.
  The broker replenishes snapshot credit independently of app handlers.
- An unexpected terminal or lease failure of this stream closes the device plane.

**Live selection.** `sessionAck.device` is the ceiling for the whole connection. Both
endpoints compute the live selection from each snapshot as the ack's
`(name, version)` entries whose revision the snapshot lists (ack ∩ latest snapshot).
A snapshot can narrow the live selection or restore an entry an earlier snapshot
withdrew; it never widens it and never changes a selected revision. A capability or
revision absent from the ack stays unsupported for the rest of the connection even
when a later snapshot lists it. Existing requests keep their revision; advertisement
changes alone do not cancel work, while an actual loss of permission or hardware
terminates affected requests with `revoked` or `unavailable`. A request naming a
revision outside the live selection is refused by the client with `unsupported`.
`supports()` reports the live selection and does not imply user consent.

**Session start.** A client that supports devices sends `hello` as its first message.
For a client that sends no `hello`, a server either initializes a session after its
hello grace period or closes the connection after its hello timeout; a session
initialized without `hello` has no device plane. A client accepts the first `sessionAck` that
carries `device` as its selection; an ack without `device` means "not selected yet".
Once selected, the handshake is immutable for that connection; capabilities change
only through `core.capabilities`.

Every revision has closed, bounded schemas (`additionalProperties: false`).
Compatibility between different registries comes from revision selection.

### 2.3 Binary frames, credit, and scheduling

Binary frames use a fixed little-endian 12-byte header:

```text
[u8 version=1][u8 flags=0][u16 channel][u32 requestId][u32 seq][payload...]
```

- `channel` and its direction are defined by the revision; blob items use unique
  channels within the revision's `maxCount`. `flags` is zero.
- A frame shorter than the header is dropped. An unknown version or nonzero flags is a
  connection-level violation (§2.1): the frame is discarded and counted and never
  terminates the request its `requestId` names. A known-id frame on an unannounced or
  invalid channel terminates the operation. Frames for unknown ids are dropped without
  allocating storage.
- A frame with a zero-length payload is a violation on a live id. A zero-byte item
  sends no frames (§2.4).
- `seq` starts at zero per `(requestId, channel)` and increments for every produced
  chunk, including deliberately dropped chunks. A lossless channel requires contiguous
  sequence numbers; `dropOldest` permits gaps. A repeated or decreasing `seq` is
  invalid. A sender terminates the request with an error before `seq` would exceed
  2^32−1.
- Binary credit counts payload bytes, excluding the header. JSON stream credit counts
  events. A request has one aggregate credit budget across its data channels and a
  single data direction. Metadata, progress and controls consume no data credit and
  have separate byte, rate and count caps.
- The data receiver grants credit. For client → server data, `initialCredit` starts
  the budget. For server → client data, `initialCredit` is zero and the client grants
  credit after admission and consent. `grant` is a positive additive integer; the
  revision defines the maximum outstanding credit. Both endpoints reject overflow,
  wrong-direction grants and data beyond credit. Credit is replenished only when
  receiver capacity is freed.
- The revision defines the overflow policy: `dropOldest` or `pause`. `paused:true` and
  `paused:false` report transitions only; after `paused:true` the sender sends no data
  until `paused:false`. A capture source states whether backpressure pauses capture,
  drops samples or stops with an error. Buffers are bounded.
- JSON streams have server-side per-request and per-connection token buckets in
  addition to credit.

**Scheduling.** Each sender limits binary chunks to 64 KiB and uses a bounded queue
shared with UI and control messages:

- Cancellation and lease traffic use a reserved bounded queue and are sent before the
  next bulk chunk. Ready UI messages are sent before subsequent bulk chunks. Bulk
  streams share the remaining capacity round-robin.
- Order within an operation is preserved: announcement before bytes, terminal success
  after its bytes. A cancellation may discard queued bytes. `deviceRequest` messages
  keep FIFO order; controls never overtake the request that establishes their id.
  Cancelling an unsent request removes it locally without sending `cancel`.
- Before handing bytes to the transport the scheduler checks its write capacity
  (`bufferedAmount`, drain or equivalent): at most 64 KiB of additional bulk data per
  scheduling turn, and no bulk data while the transport reports 256 KiB or more
  pending. Adapter and application queues are bounded. A receiver too slow to keep the
  UI queue bounded is disconnected, except where patch semantics allow coalescing.

**Compression.** A connection that carries a device plane MAY use
`permessage-deflate` only with no context takeover in both directions: the negotiated
extension carries `server_no_context_takeover` and `client_no_context_takeover`, so
each message is compressed independently. A server that compresses negotiates it this
way. A client that observes any other compression (context takeover in either
direction, a parameter with a value or repeated, or an unrecognised compression
extension) does not offer a device plane on that connection and runs UI-only.

### 2.4 Blob transfer, both directions

**Uploads** (client → server) use binary frames and credit. Blob sizes are optional:
no revision requires a size declaration.

1. The server sends the request with bounded initial credit.
2. The client sends `blobStart` `{channel, contentType, bytes?}` for each item before
   any bytes on that channel. `bytes`, when present, is an exact declaration; absent,
   the length is unknown. A sender that knows the size SHOULD declare it. The receiver
   rejects duplicate channels, excess items, disallowed metadata and a declared size
   above the revision's `maxItemBytes` before allocating a sink.
3. The client sends credit-paced chunks. The receiver enforces the revision's
   `maxItemBytes` per item and its per-connection retained-bytes budget as bytes
   arrive. Exceeding `maxItemBytes` or a declared size is `invalidParams`; exceeding
   the budget is `throttled`. The server writes into a bounded streaming sink.
4. Terminal success states each item's actual `{channel, contentType, bytes, sha256}`,
   which MUST equal what was received and, when declared, the declaration. The server
   completes pending writes and verifies the exact item set, metadata, sizes and hashes
   before the handler sees the result. A mismatch is a local `invalidParams` failure.
5. A zero-byte item is announced (`bytes: 0` or undeclared), sends no frames, and its
   terminal item has `bytes: 0` and the SHA-256 of the empty string.

**Live capture** (`mic.record`, `camera.capture` video):

- A live recording's `blobStart` omits `bytes`. Drivers stream as they capture and
  never spool to a file to learn the size.
- `mic.record` sends one item of little-endian PCM16 at the requested rate,
  interleaved when `channels` is 2. `maxDurationMs` (1..600000) limits duration.
- Overflow `pause` is bounded: when credit is exhausted the sender reports
  `paused: true` and captures into a bounded window; if no grant arrives before the
  window fills, the operation ends with `throttled`.
- Stop is success: the indicator's Stop (§5), the capture UI's Stop and reaching
  `maxDurationMs` end the recording with a success carrying what was captured. Host
  suspension ends it the same way unless a background revision was negotiated. Owner
  cancellation, deadline, lease loss and revocation end it with the corresponding
  error and discard it.
- The terminal states the actual byte count and the SHA-256 over everything sent. A
  stream API MAY deliver the bytes in order as they arrive, replenishing credit as the
  consumer returns, and resolve with the verified result.

**Downloads** (`file.save`, server → client):

- Params declare `{channel: 0, name, contentType, bytes, sha256}`; the request is the
  announcement. The DeviceHost validates limits before showing any interaction.
- The DeviceHost grants no credit until consent and destination selection complete.
  It then grants a window of at most 256 KiB (and at most the revision's
  `maxOutstandingCredit`), replenished as bytes reach the destination or a temporary
  file. The client never holds more than that window in memory. A sender exceeding
  credit is rejected without writing.
- Frames follow §2.3. The declared byte count marks the end. The client verifies size
  and hash and finishes writing before returning success. Drivers write to a temporary
  destination where the platform allows it and remove it on failure or cancellation; a
  driver without atomic commit documents that errors can leave partial output.
- Every host that advertises `file.save` implements the download plane.

**Retention.** Temporary data and completed but unconsumed results count toward the
connection's retained-bytes budget. The SDK releases them on cancellation, failure,
connection loss and disposal. A unary operation still pending when its initiating
handler returns is cancelled; its unconsumed results are released. Streams MAY
outlive the handler until their owner ends. Applications copy data into their own
storage to keep it. An endpoint without a streaming store uses a bounded in-memory
sink and advertises only limits it can honor.

### 2.5 Transport profile and broker reset

The device plane requires:

- ordered device-message routing in both directions, connection identity, close and
  teardown notifications, timers, and the scheduling of §2.3;
- for binary capabilities, `SessionTransport.sendBinary` and
  `RemoteSession.receiveBinary` (and the client equivalents) on both endpoints;
- a transport that satisfies the compression rule of §2.3 before negotiation.

**Loss of broker state is a connection reset.** An adapter that sees a live socket
without its device broker MUST close it (1012 on WebSocket) before processing any
further message. It MUST NOT synthesize `hello`, allocate a new id sequence or rebuild
a broker under that socket. The client tears down host UI, streams, leases, queues and
temporary data, then reconnects with a full advertisement. When the server process
survives, it fails outstanding work with `connectionLost`. No device operation is
replayed or resumed. The same close rule applies when the client loses its DeviceHost
state.

A Cloudflare Durable Object records a device marker in the socket attachment before
acknowledging negotiation; on wake, a marked socket with no in-memory broker is closed.

Callbacks capture their broker and connection identity; a late callback from an old
connection never routes into a new broker, even for the same numeric request id.

### 2.6 DeviceHost-owned consent and activation

Receiving a request never borrows the app's latest gesture or binds the operation to
an app element. The DeviceHost:

1. Validates revision, owner and lifetime shape, parameters, limits, grant and
   cooldown policy, and prompt concurrency, and rejects inadmissible requests.
2. When consent or a fresh gesture is needed, presents a **host-owned interaction**
   naming the authenticated app origin and the operation, with Continue and Cancel.
   Labels and explanations come from the host and registry, never from server text.
   The interaction is accessible, keyboard-operable and outside the patch tree, and
   works whether or not the app's own button still exists. A host that cannot obtain
   required consent returns `unavailable`.
3. On a trusted interaction with that control, invokes the platform API within the
   platform's activation window without a server round trip and without dispatching
   an app action. One acceptance consumes only that request; repeated taps and other
   app gestures do not start another operation.
4. Settles the operation and removes the interaction on success, refusal,
   cancellation, timeout, owner cancellation or connection loss. Host refusal is
   `denied`; abandoning an admitted operation (including dismissing an OS picker) is
   `cancelled`.

A native system picker that itself supplies the per-use choice MAY be presented
directly. A persistent OS permission never replaces per-use consent for recording.
Activation requirements are registry and driver policy; no request field lowers them.
Progress events MAY report `pendingConsent`/`running`; server correctness does not
depend on them. A background request that needs an interaction waits only when the
host can present it safely, otherwise returns `unavailable`.

### 2.7 Ownership, cancellation, and leases

Module instances have opaque connection-local ids that are never reassigned. Each
activation of an instance has an `activationId` that strictly increases per instance.
A client refuses a request under an older `activationId` than one it has seen for the
same instance with `invalidParams`. Lifetimes allowed by a revision:

- `activation`: the owner is `{moduleInstanceId, activationId}`. Deactivating the
  instance (navigating away from its screen) cancels the work; reactivation never
  resumes it. A handler continuation keeps the activation it started under: after that
  activation ends it cannot start device work.
- `background`: the owner is `{moduleInstanceId}`. Destroying the instance cancels
  the work; deactivation does not. Requires a revision that allows it, separate
  background consent and an indicator on the client, and a hard cap on pinned owners on
  the server.
- `connection`: the owner is `{connection: true}`; reserved for protocol control
  (`core.capabilities`). App code cannot use it.

The broker maps every request to its owner and cancels owned work on deactivation and
destruction. The DeviceHost validates and stores the owner but never infers module
transitions from patches; the server's `cancel` is authoritative. Host suspension (the
app leaving the foreground) stops activation-owned hardware and pending prompts; only
permitted background work continues. Presenting the request's own system picker is
not a suspension. Local policy MAY be stricter.

Activation authority begins before `onActivated` runs and ends before `onDeactivated`
runs. Device calls from `onCreated` before the first activation, and from
`onDeactivated` and `onDestroyed`, return `unavailable` (`owner-inactive`) at once.

**Leases.** Every request has a lease independent of credit and deadline: 15 seconds,
renewed every 5 seconds, on monotonic clocks.

- Receipt of a valid request starts the client's lease, including while consent is
  pending. The server sends `renewLease` with sequence 1 immediately after the request,
  then every 5 seconds while the request and its owner are live.
- A first renewal other than 1 is a violation. The client accepts only increasing
  sequences, sets its expiry to 15 seconds after receipt, and echoes the sequence as
  `leaseAck` immediately, including while pending consent, paused or idle. A
  duplicate MAY be acknowledged again but does not extend the lease. A renewal never
  creates or revives a request.
- The server tracks sent renewals in a bounded window. An acknowledgement of a newer
  sent sequence advances its state; unsent (future) sequences are invalid; repeated or
  older ones do not refresh liveness. With no acknowledgement progress for 15 seconds
  the server fails the request with `connectionLost` and sends `cancel`. The client
  stops on its own expiry with the same error. Expiry is checked before processing a
  queued acknowledgement or renewal and after timers resume.
- At most one unsent renewal is queued per request (the latest sequence). Lease
  sequences are positive `u32`; the server terminates the request before exhaustion.
- Data frames, progress and grants never refresh a lease. Renewals and
  acknowledgements bypass data credit and use the control queue. Renewals stop when
  the owner ends.

## 3. Capability registry and errors

| Capability | Mode | Consent | Lifetime | Scope |
|---|---|---|---|---|
| `core.capabilities` | stream, JSON events | none | connection | Full replacement advertisements |
| `permission.query` | unary | none; never prompts | activation | Status of one `Permission` |
| `permission.request` | unary | per use | activation | Host consent, then the OS prompt for one `Permission` |
| `gallery.pick` | unary, binary upload | per use; the picker is the gate | activation | Photos and videos |
| `file.pick` | unary, binary upload | per use; the picker is the gate | activation | Files, filtered by `accept` |
| `file.save` | unary, binary download | per use; host consent, then destination picker | activation | One file |
| `camera.capture` | unary, binary upload (1 item, 64 MiB, 600 s) | per use; the host capture UI is the gate | activation | Photo or video |
| `mic.record` | stream, binary upload | per use; visible indicator with Stop | activation | PCM16 recording |
| `bluetooth.select` | unary, no data plane (300 s) | per use; the host chooser is the gate | activation | One BLE device's identity |
| `bluetooth.scan` | stream, JSON events | persistable with expiry; visible indicator with Stop | activation | BLE advertisements |

Each revision defines its parameter, result and event schemas, directions, maximum
sizes, initial and maximum credit, deadline bounds, overflow behavior and platform
policies.

**Permissions.** `permission.query@1` and `permission.request@1` take
`{"permission": Permission}` where `Permission` is the closed enum
`camera | microphone | photos | location | notifications | bluetooth | contacts`; any
other value is `invalidParams`. The result is
`{"status": "granted" | "denied" | "prompt"}`. A host that cannot represent a
permission answers `unsupported` with the permission name as `platformDetail`.
Permission status is distinct from capability support and from consent. Consent
grants are keyed by `(origin, capability, consentScope)`; OS permission groups MAY
share status snapshots and cooldowns, never authorization.

**Capture.** `camera.capture@1` params are
`{"mode": "photo" | "video", "facing"?: "front" | "back", "maxDurationMs"?: 1..600000}`,
with `maxDurationMs` allowed only for video. The result is `{"items": [blobItem]}`
with exactly one item on channel 0: a photo is `image/jpeg` or `image/heic`, a video
`video/mp4`, `video/quicktime` or `video/webm` (bare media types), and an item whose
type does not fit the mode is disallowed metadata. Native video capture also requires
the `microphone` permission. `mic.record@1` params are
`{"format": "pcm16", "sampleRate": 8000..192000, "maxDurationMs"?: 1..600000,
"channels"?: 1 | 2}` (absent `channels` = 1); the result is
`{"durationMs", "item": blobItem}`.

**Bluetooth.** `bluetooth.select@1` params are
`{"services"?: [uuid] (1..16, unique), "namePrefix"?: string (1..64 code points)}`,
each UUID in canonical lowercase 128-bit form (16-bit SIG ids expanded, e.g.
`0000180d-0000-1000-8000-00805f9b34fb`). The result is
`{"device": {"id": string (1..128), "name"?: string (≤256)}}`. `bluetooth.scan@1`
events are `{"device": {"id", "name"?, "rssi"}}`. Device ids are opaque to the server.

**Errors.** Protocol version 1 has a closed set of error codes:

| Code | Meaning |
|---|---|
| `unsupported` | The capability or revision is not implemented or not selected |
| `unavailable` | Current host state or dispatch policy prevents execution |
| `denied` | The user or OS refused permission or consent |
| `revoked` | A granted permission was withdrawn; affected work stops |
| `cancelled` | The user, owner or caller abandoned an admitted operation |
| `timeout` | The deadline expired |
| `throttled` | A prompt, rate or resource limit prevented execution |
| `connectionLost` | The transport, broker or lease was lost |
| `invalidParams` | Parameters or wire data violate the selected schema |
| `internal` | Unexpected driver or host failure |

`platformDetail` is bounded diagnostic text; handlers MUST NOT branch on it. A new
code requires a new protocol version. Revocation stops capture and clears host
buffers; deleting data derived on the server is the application's responsibility.

## 4. Server SDK requirements

```ts
const res = await context.device.request("gallery.pick", {
  mediaTypes: ["photo"], maxCount: 1,
});
if (res.ok) {
  const bytes = await res.value.items[0].bytes(); // verified, bounded
  await storeAvatar(bytes);                       // app-owned persistence
}

const scan = context.device.stream("bluetooth.scan", {});
scan.intoState("devices", (list, ev) => fold(list, ev));
context.device.supports("mic.record"); // live selection, not a permission grant
```

- **Device plane on by default.** A server negotiates a device plane for every client
  that offers one, with no configuration. Options are set with `configureDevice(...)`;
  `disableDevice()` (Cloudflare: `device: false`) turns the device plane off for the
  server. An allow-multiple session mode (one session fanned out to several sockets)
  runs without a device plane, with one startup warning.
- **Handler context.** Action and lifecycle handlers receive a device context scoped
  to their invocation: it carries the owner (module instance and activation) and the
  dispatch provenance. App code cannot supply or forge an owner. Replay provenance
  survives `await` and inherited callbacks.
- **Results as values.** Every call returns a result value; `unsupported`, refusals,
  replay rejection, timeouts and cancellation are ordinary errors, never exceptions.
  Results are validated and verified before handlers see them. Handlers re-check their
  state after waiting; it may have changed.
- **Typed API.** `request(capability, params)` and `stream(capability, params)` are
  typed from a capability map generated from the registry (latest revision per name),
  so an unknown name or ill-typed params is a compile error; an untyped variant exists
  for dynamic names. A binary-upload stream (`mic.record`) MAY deliver bytes in order
  as they arrive. Convenience wrappers (`gallery.pick`, `camera.capture`,
  `mic.record`, `bluetooth.select`, `permissions.query/request`, …) are aliases. A
  server advertises exactly the capabilities it exposes an API for.
- **Stream state.** `intoState` applies events through a deferred microtask and
  exposes a terminal marker; an ended stream never leaves state implying it is live.
- **One broker.** Every server SDK runs the same sans-IO broker (`hypen-engine`
  `device::DeviceBroker`: ids, owners and sweeps, leases, deadlines, credit and token
  buckets, blob verification, downloads, scheduling, `core.capabilities`, violation
  reactions), fed with socket data and a monotonic clock. Each SDK supplies admission,
  the handshake, the socket pump, timers, the replay firewall and its API. The broker
  admits a request only for its owner's current activation. An explicit
  `initialCredit` of zero on a client → server data plane is refused locally.
- **Default lifetime** is `activation`. `background` is an explicit request option,
  validated against the registry and admitted independently by the DeviceHost.

## 5. DeviceHost and security

- The DeviceHost is a separate package. It owns drivers, consent UI, grant storage,
  request state, leases, binary sinks and teardown. The engine contains schemas, not
  device runtime code; renderers have no device behavior.
- **Grants.** Grants persist only for authenticated `wss://` origins, keyed by
  normalized origin (scheme, host, effective port), not by certificate. `ws://` grants
  last for the connection, in a visible development mode.
- **Consent.** Per-use consent is required for each operation. Persistable grants
  expire and are re-affirmed. Cooldowns persist across reconnect and restart with
  capped backoff. Permission revocation is handled separately from capability support.
- **Prompt concurrency.** At most one prompt-raising operation runs per DeviceHost,
  across all its connections; another request meanwhile gets `throttled`. Server text
  never appears as trusted host UI.
- **Indicators.** `mic.record`, a camera video recording and `bluetooth.scan` show a
  host indicator for their whole duration: outside the patch tree, naming the origin,
  with a Stop control that app UI cannot hide or restyle. Stop ends a recording with a
  success (§2.4) and a scan with `cancelled`. A platform without a compliant
  background indicator does not advertise background revisions.
- **Capture UI and chooser.** For `camera.capture` the host's capture UI (live
  preview with Capture, Record/Stop and Cancel, outside the patch tree, armed against
  stray input like the consent dialog) is the per-use consent; nothing is captured or
  sent before a trusted interaction with it, and its Cancel is `cancelled`. For
  `bluetooth.select` the host chooser listing a live scan is the consent and, while
  open, the indicator; it returns only the chosen device's identity.
- **Teardown.** Work stops and is cleaned up on cancellation, deadline, lease expiry,
  connection loss, broker reset, permission revocation and host suspension. An OS
  dialog that cannot be dismissed is cleaned up on a best-effort basis and never
  resumes cancelled work.
- **Routing.** Device messages use dedicated `sendDevice`/`sendBinary` routes that
  are not assignable to UI `OutgoingMessage`, enforced at runtime. Replayed or
  broadcast dispatches never acquire device authority.
- **Connection admission.** Admission applies equally to UI and device traffic:
  - with an `Origin` allowlist configured, a request carrying `Origin` MUST name an
    allowed origin, and a request without `Origin` is admitted only by the
    authenticator;
  - with an authenticator (`authenticate(request) → boolean`) configured, it MUST
    return true for every upgrade, with or without `Origin`;
  - with neither configured, every upgrade is admitted and the server logs one
    startup warning.
  Any other result is 403. `Origin` only defends browsers against cross-site
  WebSocket hijacking; native clients send no `Origin` and authenticate with app
  credentials in upgrade headers. Ids, client permission reports and hashes are never
  proof of user authorization.
- **Resume credential.** A server with a device plane adds `"resumeToken"` (base64url,
  at least 128 random bits) to every `sessionAck`, rotating it on each acknowledged
  connection. A client resuming that `sessionId` sends the latest value as
  `hello.resumeToken`; the server compares it in constant time. Resuming (or taking
  over) a session that negotiated a device plane requires the valid token; a missing
  or wrong token starts a new session (`isNew: true`), never an error or a takeover. A
  session that never had a device plane resumes by id. A server-authenticated recovery
  channel (the Cloudflare hibernation attachment) needs no token.
- **Parse bounds.** Incoming frames are bounded before parsing, as are parsed depth
  and size, metadata, grants, prompts, leases, binary buffers and retained results.
  The JSON limits of §2.1 are the shared parse bounds. A violation never allocates
  unbounded memory.

## 6. Versioning and stability

Protocol version 1 fixes the envelope (§2.1), the handshake (§2.2), binary frames and
credit (§2.3), transfers (§2.4) and leases (§2.7). A change to any of them requires a
new protocol version, negotiated in `hello`.

Capability revisions are identified by `(name, version)`. The `@1` revisions defined in
§3 and in `engine-compatibility-tests/schema/device/` are **provisional**: their
schemas carry a provisional marker and MAY change in place. A revision becomes stable
when its marker is removed; a stable revision is immutable, and any change to it,
including an optional addition, creates a new revision. A breaking semantic change uses
a new capability name.

## 7. Platform requirements

- **Browser activation.** Transient user activation is time-limited and can be
  consumed; a WebSocket round trip does not preserve it. Web drivers therefore obtain
  activation from the host-owned interaction of §2.6.
- **Detection.** Drivers detect support per API and platform. A Bluetooth chooser is
  not unrestricted scanning; querying a permission is not prompting for it.
- **Native pickers.** A system picker MAY be presented without an app gesture or
  broad library permission. Drivers observe native presentation and background
  restrictions and return `unavailable` when they cannot present.
- **Browser WebSocket.** Browsers expose `send(data)`, `bufferedAmount` and the
  negotiated `extensions`, not a per-message compression flag or the server
  certificate. Grants and admission use only what the platform exposes.
- **Durable Object hibernation** can keep a socket while losing its broker; §2.5
  closes such a connection.

## 8. Conformance

An implementation conforms when it passes the shared corpus in
`engine-compatibility-tests/fixtures/device/` (messages, payloads, selection, frames
and transcripts, including every violation reaction) and these scenarios:

| Area | Required behavior |
|---|---|
| Host interaction | With the app button disabled or removed, the host's Continue still opens the picker and emits no app action. A request from `onActivated` works with no prior app action. |
| Consent concurrency | App clicks do not consume a pending interaction; a double Continue invokes once; another prompt gets `throttled`; a cancelled request's late OS result is not uploaded. |
| Ownership | Two instances of the same module are isolated; deactivating cancels activation-owned work and reactivating does not revive it; a continuation from an ended activation cannot start work; background work follows its owner. |
| Connection control | Navigating between modules keeps `core.capabilities` open; reopening before its deadline yields a fresh full snapshot. |
| Mixed registries | Older client with newer server and newer client with older server select the common revision and validate both directions; parameters needing a newer revision fail without a lossy downgrade. |
| Revision pinning | Advertisement changes during a transfer keep its revision; only later requests use the new selection. |
| Selection ceiling | A capability absent from the ack but listed in a later snapshot stays unsupported on both endpoints; one withdrawn and restored within the ack works again. |
| Reset | Losing the broker under a live socket closes it before its next message, stops hardware, discards temporary data, re-advertises on reconnect and never replays the request. |
| Ids and callbacks | Duplicate and retired ids are ignored; the connection closes before id exhaustion; an old connection's callback cannot settle a new request with the same id. |
| Leases | An idle scan, a zero-credit transfer and a consent wait survive through renewals; silence expires both sides; duplicate or future acknowledgements do not refresh; a late renewal does not revive an expired request. |
| Termination races | Client and server deadlines, cancel versus success, client cancellation and an undismissable OS dialog each settle exactly once; the server never sends `deviceResponse`. |
| Binary integrity | Codec golden bytes; sequence, direction and flag validation; channel limits; metadata before bytes; empty frames; declared and undeclared sizes; size or hash mismatch; terminal ordering. |
| Resource limits | Oversize declarations are rejected before allocation and undeclared items as bytes arrive; JSON limits apply before parsing; aggregate credit and retained-result caps hold; unused results are released when the handler returns. |
| Scheduling | With bulk streams saturating a slow transport, pending control and UI messages go out at the next opportunity, bulk streams share capacity and queue bounds hold. |
| Compression | A connection compressed per message (both no-context-takeover parameters) carries the device plane; a client seeing context takeover in either direction stays UI-only. |
| Isolation | One dispatch produces one request on its own connection; a replayed dispatch cannot request hardware, including after `await`; a forged cross-connection response cannot settle another request. |
| Platform drivers | Real pickers, capture and recording on each platform; revocation, deactivation, disconnection and host suspension stop the documented resources. |

## 9. References

- [HTML user activation model](https://html.spec.whatwg.org/multipage/interaction.html#tracking-user-activation)
- [WebSocket API and buffering](https://websockets.spec.whatwg.org/#the-websocket-interface)
- [RFC 7692: Compression Extensions for WebSocket](https://www.rfc-editor.org/rfc/rfc7692)
- [JSON Schema additional properties](https://json-schema.org/understanding-json-schema/reference/object#additionalproperties)
- [Durable Objects WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#how-hibernation-works)

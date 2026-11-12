# Messages — Hypen Example

A real-time chat between the people who have the app open: public rooms
(`#general`, `#random`, plus any room a visitor creates) and direct messages,
with message bubbles, grouping, day separators and timestamps, typing
indicators, "Seen" receipts, online dots, unread badges, emoji reactions,
link previews and photo messages. Nothing is mocked: every message comes from
another connected browser and is stored in the Durable Object's SQLite.

```
messages/
└── cloudflare/
    ├── src/
    │   ├── worker.ts     # worker + DO subclass: visitor cookie, socket scope, /img/<id>
    │   ├── messages.ts   # the module: thin action handlers + the inline DSL template
    │   ├── hub.ts        # ChatHub: SQLite schema, fan-out, presence, typing, receipts, rate limits
    │   ├── state.ts      # per-session state shape (pre-formatted views for the template)
    │   ├── scope.ts      # AsyncLocalStorage: which socket/visitor a handler runs for
    │   ├── links.ts      # OpenGraph link previews with SSRF guards
    │   └── text.ts       # input hygiene, limits, time formatting, image sniffing
    ├── safety.test.ts    # SSRF guard, OG parsing, text limits, image sniffing
    ├── wrangler.jsonc
    ├── package.json
    └── tsconfig.json
```

## Run it

```bash
cd cloudflare
bun install
bun run dev          # wrangler dev → http://localhost:8798 (inspector 9240)
bun test             # safety unit tests
```

Open `http://localhost:8798` in two different browsers (or one normal and one
private window, since each visitor is a cookie). Pick a name and colour in
each, open `#general`, and chat. Tap a face in the "online" strip to start a
DM. In the launcher the app is embedded with `HypenApp("ws://localhost:8798/ws")`.

`bun run dev` uses the published packages. Photo messages need the device
plane, and the published `hypen-engine` 0.6.7 already includes the broker.
`wrangler dev`'s own proxy still negotiates WebSocket compression with context
takeover, though, so do one of these:

- run it through `scripts/dev-examples.sh` (once `messages` has an entry in
  that script's table), which patches the proxy (see the `run-examples`
  skill), or
- apply the same one-line patch to this example's `node_modules/wrangler`
  yourself.

Without the patch, everything except photo messages works and the `+` button
stays hidden.

`wrangler dev` logs `no allowedOrigins/authenticate configured`. Before
deploying, set `allowedOrigins` in `worker.ts` to this worker's origin plus the
launcher's.

## Durable Object topology

**One coordinator DO for the whole app (`hub:main`)**, holding every socket
and the chat's SQLite. Each socket is still its own Hypen session with its own
module state (screen, open room, draft, scroll window). `syncActions` is off
because visitors must not share UI state. The DO also owns a `ChatHub`
(`hub.ts`) that every session registers with from `onCreated`.

A write (send, react, read, rename, connect or disconnect) updates SQLite
first. The hub then re-derives the affected views directly on each interested
session's live state proxy: the thread for viewers of that room, conversation
rows and unread counts for everyone who can see it, and the typing line,
receipts or online dots. The Hypen runtime diffs each mutated state and sends
patches down that socket, so fan-out costs one state mutation per interested
session, with no message bus.

Why not one DO per room? A Hypen session is bound to one socket, and the socket
lives in exactly one DO. With per-room DOs, the conversation list (unread
badges and previews for every room, presence for every DM partner) would need
every room DO to push into every visitor's session DO. That means
RPC/WebSocket fan-out between DOs, ordering problems, and N×M subscriptions.
Sending typing pings and read receipts across DOs would multiply that traffic.
A single coordinator keeps all of it in one isolate, transactional with
SQLite, and in order. The limit is one DO's throughput: comfortably thousands of
sockets for a chat like this, but not a global service. To scale out, shard by
community (derive `getRoutingKey` from a path or subdomain: one hub per
workspace), not by room.

**Hibernation.** The hub runs a 1 s ticker while anyone is connected. The
ticker expires typing indicators, and it also keeps the DO resident on purpose.
Hibernation would empty the in-memory connection registry, and a hibernated
socket only rebuilds its session when it next sends a message, so idle readers
would miss fan-out. With no sockets, the ticker stops and the DO can be
evicted. Session snapshots still restore a reconnecting tab (its open room is
re-checked for access first).

**Identity.** Each visitor gets a random `hypen_msg` cookie (HttpOnly,
SameSite=Lax), stored per visitor alongside their name and colour in the
`visitors` table:

- On a direct visit, the first page load mints it.
- When the app is embedded in the launcher, the visitor may never load our
  page, so the WebSocket handshake response mints it.

The worker overwrites an `X-Hypen-Msg-Visitor` header with the cookie value,
and the DO stamps it onto the socket's hibernation attachment. The DO runs
every socket event inside `connScope` (AsyncLocalStorage), and handlers read
the caller from there, never from module state. The worker also passes the
visitor's timezone from `request.cf.timezone`, so times and "Today"/"Yesterday"
are local. Native clients without a cookie jar get a fresh identity per
connection.

## Data

| Table | What |
|-------|------|
| `visitors` | id (cookie), name, colour, last seen |
| `rooms` | public rooms (slug) and DMs (`d:<a>\|<b>`, sorted member ids) |
| `messages` | text/image messages, link-preview JSON. **Capped at 500 per room.** Older rows and their reactions/images are deleted. |
| `reactions` | message × visitor × emoji (six fixed emoji) |
| `reads` | per-room read pointer per visitor. Drives unread counts and "Seen". |
| `images` | uploaded photo bytes (≤ 1 MB each, newest 200 kept), served at `GET /img/<id>` |

**Pagination.** A thread opens with the newest 40 messages. Scrolling within
400 px of the top loads 30 more (a session holds at most 300). The message
list sits in a `column-reverse` scroller, so it stays pinned to the newest
message as messages arrive and keeps its place when older pages are inserted
above. A "Load earlier messages" button does the same for renderers without
scroll events.

## Features → where

- **Bubbles and grouping:** consecutive messages from one author within 5 min
  form a group. Only the group's last bubble gets the avatar and the time, only
  the first gets the name (in rooms), and inner corners tighten (`radius` is
  computed per row in `renderThread`).
- **Typing:** `Input.bind(@state.draft).onInput(@actions.typing)`. The hub
  fans out only when someone starts or stops typing, and it expires typers
  after 4 s.
- **Receipts:** under your last message. In DMs it shows *Sent*, *Delivered*
  (the other person is online) or *Seen*. In rooms it shows *Seen by Ada, Bo
  +3*. Opening a room or receiving while it's open advances your read pointer.
- **Presence:** online dots on faces, DM rows and the DM header, "N others
  online", and "Last seen 5m ago".
- **Unread badges:** per conversation, from the `reads` pointers.
- **Reactions:** tap a bubble to open the reaction bar, or tap a chip to toggle
  your own reaction.
- **Link previews:** the first URL of a message is fetched server-side after
  the message is sent. The preview appears as a card when it arrives.
- **Photos:** the `+` button uses `context.device.request("gallery.pick")`,
  falling back to `file.pick`. The bytes arrive over the device plane, are
  sniffed, and are stored in SQLite.
- **New-DM notifications:** a toast slides in when a DM arrives in a
  conversation you aren't viewing. Tap it to jump there.

## Safety

- **Length limits:** names are 1–24 characters, room slugs are 2–24 characters
  of `a-z0-9-`, and messages are capped at 1000 characters. Control
  characters, zero-width and bidi-override characters are stripped, and runs
  of blank lines are collapsed (`text.ts`).
- **Escaping:** user text only ever travels as state values, and the DOM
  renderer writes those with `textContent`. Nothing user-supplied is spliced
  into the DSL template, so `<b>` and `@{state.x}` render literally (verified
  in the browser). `Link` and `Image` only ever get `http(s)` URLs
  (`safeHttpUrl`). The renderer's `Link` does not filter `javascript:`.
- **Rate limits:** per-visitor token buckets.

  | Action | Limit |
  |--------|-------|
  | Messages | 6 burst, then ~1 every 1.4 s |
  | Photos | 1 every 10 s |
  | New rooms | 3, then 1 every 5 min |
  | Reactions | 20 burst |
  | Profile edits | 5 burst |

  Refusals show as an inline notice.
- **Link previews** (`links.ts`):
  - Only `http(s)` URLs on default ports, with no credentials.
  - IP literals in private, loopback, link-local/metadata, CGNAT, ULA,
    multicast or v4-mapped ranges are blocked, as are numeric host tricks,
    `localhost`, single-label names and `.local`/`.internal`-style suffixes.
  - Redirects are followed manually and re-checked at every hop (at most 3).
  - The fetch times out after 4 s, only `text/html` is accepted, and at most
    256 KiB is read.
  - Extracted strings are capped, and the preview image must be public
    `https`.
- **Photos:** only PNG, JPEG, GIF and WebP are accepted, identified by their
  magic bytes. SVG is never accepted. Each photo is at most 1 MB. Photos are
  served with `nosniff`, a `default-src 'none'; sandbox` CSP, and an
  unguessable UUID path.
- **Authorization:** every room/DM/message access is checked against the
  caller's visitor id in the hub (`canAccess`). A DM is visible only to its
  two members.

## SDK notes (found while building this)

- **No notification capability.** The device registry has
  `permission.query`/`permission.request` for `"notifications"` but no
  capability that shows a notification, and the module gets no
  focus/visibility signal from the client. New DMs therefore use an in-app
  toast. Once a `notification.show` capability exists, `ChatHub.showToast` is
  the place to call it (from the receiving session's context).
- **`When` case switches reuse the case root node, and the DOM renderer
  (`@hypen-space/web` 0.6.5) does not clear some removed props.** The engine
  sends `RemoveProp maxWidth.0` / `overflowY.0`, but the CSS stays, so the
  setup screen's `max-width: 420px` leaked onto the conversation list. As a
  workaround, every screen root sets the same prop names (`maxWidth`,
  `overflowY`, …).
- **`.label()` with an `@{}` binding produces no accessible name.** For
  example, `.label("Colour @{swatch.color}")` inside a `ForEach`: no
  `semantics.name` is emitted. Static labels work.
- **A child under `If` in a `Row` is auto-stretched** (`align-self: stretch;
  width: 100%`). The unread badge filled the row until it was given
  `.width("auto").alignSelf("center")`.
- **The engine logs `Component "Link" did not resolve`** for `Link { … }`, yet
  the DOM renderer renders a working `<a>`.

/**
 * ChatHub — the one place chat data lives and fans out from.
 *
 * Topology (see README): every socket of a deployment lands in ONE
 * coordinator Durable Object ("hub"). Each socket is its own Hypen session
 * with its own module state (current screen, open room, draft, scroll
 * window), and this hub — one per DO, owned by the DO instance — holds:
 *
 *   - the durable data in the DO's SQLite: visitors (profile per cookie),
 *     rooms (public rooms + DMs), messages (capped per room), reactions,
 *     read pointers, uploaded images;
 *   - the live registry of connections (`conns`): which visitor, which room
 *     they are looking at, and their module's live state proxy.
 *
 * A write (send, react, read, profile edit, presence) updates SQLite and then
 * re-derives the affected views directly on every interested connection's
 * state proxy. The Hypen session notices the mutation, diffs it, and sends
 * patches down that socket — so fan-out is just "mutate N state objects".
 *
 * Every handler identifies its caller through `scope.ts` (an
 * AsyncLocalStorage the DO sets around each socket event), never through
 * state the client could influence.
 */

import { fetchPreview, type LinkPreview } from "./links";
import type { ConversationView, MessageView, MessagesState, PersonView, RoomHeader } from "./state";
import { EMPTY_ROOM, EMPTY_TOAST } from "./state";
import {
  LIMITS,
  PALETTE,
  REACTIONS,
  agoLabel,
  clockTime,
  dayKey,
  dayLabel,
  firstUrl,
  initialOf,
  listTime,
  sniffImage,
} from "./text";

// ---------------------------------------------------------------------------
// Storage plumbing
// ---------------------------------------------------------------------------

interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
export interface HubStorage {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'room' | 'dm'
  title TEXT NOT NULL,         -- slug for rooms, '' for DMs
  a TEXT NOT NULL DEFAULT '',  -- DM members (sorted)
  b TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'text' | 'image'
  body TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  preview TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, seq);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  visitor TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, visitor, emoji)
);
CREATE TABLE IF NOT EXISTS reads (
  room TEXT NOT NULL,
  visitor TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (room, visitor)
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created INTEGER NOT NULL
);
INSERT OR IGNORE INTO rooms (id, kind, title, created, last_at) VALUES ('r:general', 'room', 'general', 0, 0);
INSERT OR IGNORE INTO rooms (id, kind, title, created, last_at) VALUES ('r:random', 'room', 'random', 0, 0);
`;

/** Messages kept per room; older ones (and their reactions/images) are dropped. */
const HISTORY_CAP = 500;
/** Images kept in total across the hub. */
const IMAGE_CAP = 200;
/** First page / subsequent "load older" page sizes. */
const PAGE = 40;
const OLDER_PAGE = 30;
/** Most messages one connection holds in its window. */
const WINDOW_CAP = 300;
const TYPING_MS = 4000;
const GROUP_GAP_MS = 5 * 60_000;
const TOAST_MS = 5000;

const ROOM_TOPICS: Record<string, string> = {
  general: "Say hi to everyone online",
  random: "Off-topic, links, anything goes",
};

// ---------------------------------------------------------------------------
// Rate limiting: token buckets per visitor and action kind
// ---------------------------------------------------------------------------

const BUCKETS = {
  message: { capacity: 6, perSec: 0.7 },   // bursts of 6, ~1 every 1.4 s sustained
  image: { capacity: 2, perSec: 0.1 },     // 1 every 10 s
  room: { capacity: 3, perSec: 1 / 300 },  // 3, then 1 every 5 min
  react: { capacity: 20, perSec: 2 },
  profile: { capacity: 5, perSec: 0.05 },
} as const;
type BucketKind = keyof typeof BUCKETS;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RoomRow {
  id: string;
  kind: "room" | "dm";
  title: string;
  a: string;
  b: string;
  last_at: number;
}

interface VisitorRow {
  id: string;
  name: string;
  color: string;
  last_seen: number;
}

interface Conn {
  key: object;
  visitorId: string;
  tz: string;
  state: MessagesState;
  roomId: string | null;
  /** Lowest message seq in this connection's thread window. */
  oldestSeq: number;
  toastTimer: ReturnType<typeof setTimeout> | null;
}

export type HubResult = { ok: true } | { ok: false; error: string };
const OK: HubResult = { ok: true };
const fail = (error: string): HubResult => ({ ok: false, error });

function dmId(x: string, y: string): string {
  return x < y ? `d:${x}|${y}` : `d:${y}|${x}`;
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

export class ChatHub {
  private readonly conns = new Map<object, Conn>();
  /** room id → visitor id → typing-expiry ms */
  private readonly typing = new Map<string, Map<string, number>>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly storage: HubStorage) {
    this.storage.sql.exec(SCHEMA);
  }

  private q<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] {
    return this.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  private one<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T | undefined {
    return this.q<T>(query, ...bindings)[0];
  }

  // -------------------------------------------------------------------------
  // Connections & presence
  // -------------------------------------------------------------------------

  /** Register (or refresh) a connection. Called from onCreated and on every action. */
  attach(key: object, visitorId: string, tz: string, state: MessagesState): void {
    const existing = this.conns.get(key);
    if (existing) {
      existing.state = state;
      return;
    }
    const wasOnline = this.isOnline(visitorId);
    const conn: Conn = { key, visitorId, tz, state, roomId: null, oldestSeq: 0, toastTimer: null };
    this.conns.set(key, conn);
    this.startTicker();

    const profile = this.visitor(visitorId);
    if (profile) {
      state.me = { id: profile.id, name: profile.name, color: profile.color, initial: initialOf(profile.name) };
      this.q("UPDATE visitors SET last_seen = ? WHERE id = ?", Date.now(), visitorId);
      if (state.screen === "setup") state.screen = "list";
    } else {
      state.screen = "setup";
      state.me = { id: visitorId, name: "", color: state.setupColor || PALETTE[0], initial: "" };
      if (!state.setupColor) this.pickColor(state, PALETTE[Math.floor(Math.random() * PALETTE.length)]!);
    }
    state.reactionChoices = REACTIONS.map((emoji) => ({ emoji }));

    // A resumed session (DO wake / reconnect) still names its open room.
    const resumed = state.room?.id;
    if (profile && resumed && state.screen === "thread" && this.canAccess(visitorId, this.room(resumed))) {
      conn.roomId = resumed;
      conn.oldestSeq = this.windowStart(resumed, PAGE);
      this.renderThread(conn);
    } else {
      // Nothing from a previous incarnation's thread survives unless the
      // caller may still read it.
      if (state.screen === "thread") state.screen = profile ? "list" : "setup";
      state.room = { ...EMPTY_ROOM };
      state.messages = [];
    }
    state.toast = { ...EMPTY_TOAST };
    this.renderConversations(conn);
    this.renderPeople(conn);

    if (profile && !wasOnline) this.presenceChanged(visitorId);
  }

  detach(key: object): void {
    const conn = this.conns.get(key);
    if (!conn) return;
    this.conns.delete(key);
    if (conn.toastTimer) clearTimeout(conn.toastTimer);
    if (!this.isOnline(conn.visitorId)) {
      this.q("UPDATE visitors SET last_seen = ? WHERE id = ?", Date.now(), conn.visitorId);
      for (const [room, who] of this.typing) {
        if (who.delete(conn.visitorId)) this.renderTyping(room);
      }
      this.presenceChanged(conn.visitorId);
    }
    if (this.conns.size === 0) this.stopTicker();
  }

  private conn(key: object): Conn | undefined {
    return this.conns.get(key);
  }

  private isOnline(visitorId: string): boolean {
    for (const c of this.conns.values()) if (c.visitorId === visitorId) return true;
    return false;
  }

  private onlineVisitors(): Set<string> {
    const set = new Set<string>();
    for (const c of this.conns.values()) if (this.visitor(c.visitorId)) set.add(c.visitorId);
    return set;
  }

  private presenceChanged(visitorId: string): void {
    for (const c of this.conns.values()) {
      this.renderPeople(c);
      this.renderConversations(c);
      if (c.roomId && c.roomId === dmIdOrNull(c.visitorId, visitorId)) this.renderHeader(c);
    }
  }

  /**
   * A 1 s ticker while anyone is connected: expires typing indicators, and —
   * deliberately — keeps the DO resident. A hibernated hub would lose its
   * in-memory connection registry, and a socket only rebuilds its session
   * when IT next sends something, so idle readers would miss fan-out.
   */
  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick(): void {
    const now = Date.now();
    for (const [room, who] of this.typing) {
      let changed = false;
      for (const [v, until] of who) {
        if (until <= now) {
          who.delete(v);
          changed = true;
        }
      }
      if (who.size === 0) this.typing.delete(room);
      if (changed) this.renderTyping(room);
    }
  }

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  private allow(visitorId: string, kind: BucketKind): boolean {
    const spec = BUCKETS[kind];
    const k = `${visitorId}:${kind}`;
    const now = Date.now();
    const b = this.buckets.get(k) ?? { tokens: spec.capacity, at: now };
    b.tokens = Math.min(spec.capacity, b.tokens + ((now - b.at) / 1000) * spec.perSec);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(k, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(k, b);
    if (this.buckets.size > 5000) this.buckets.clear(); // crude bound on memory
    return true;
  }

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  private visitor(id: string): VisitorRow | undefined {
    return this.one<VisitorRow>("SELECT id, name, color, last_seen FROM visitors WHERE id = ?", id);
  }

  pickColor(state: MessagesState, color: string): void {
    state.setupColor = color;
    state.colors = PALETTE.map((c) => ({ color: c, selected: c === color }));
  }

  saveProfile(key: object, name: string, color: string): HubResult {
    const conn = this.conn(key);
    if (!conn) return fail("Not connected.");
    if (!this.allow(conn.visitorId, "profile")) return fail("Too many profile changes — try again in a minute.");
    const now = Date.now();
    const existed = !!this.visitor(conn.visitorId);
    this.q(
      `INSERT INTO visitors (id, name, color, created, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, last_seen = excluded.last_seen`,
      conn.visitorId, name, color, now, now,
    );
    if (!existed) {
      // Start a newcomer "caught up" on existing public rooms.
      this.q(
        `INSERT OR IGNORE INTO reads (room, visitor, seq)
         SELECT r.id, ?, COALESCE((SELECT MAX(seq) FROM messages m WHERE m.room = r.id), 0)
         FROM rooms r WHERE r.kind = 'room'`,
        conn.visitorId,
      );
    }
    const me = { id: conn.visitorId, name, color, initial: initialOf(name) };
    for (const c of this.conns.values()) {
      if (c.visitorId === conn.visitorId) {
        c.state.me = me;
        if (c.state.screen === "setup") c.state.screen = "list";
        c.state.editingProfile = false;
      }
    }
    // Names/colours show up in other people's lists and threads.
    for (const c of this.conns.values()) {
      this.renderPeople(c);
      this.renderConversations(c);
      if (c.roomId) {
        this.renderHeader(c);
        this.renderThread(c);
      }
    }
    return OK;
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  private room(id: string | null | undefined): RoomRow | undefined {
    if (!id) return undefined;
    return this.one<RoomRow>("SELECT id, kind, title, a, b, last_at FROM rooms WHERE id = ?", id);
  }

  private canAccess(visitorId: string, room: RoomRow | undefined): room is RoomRow {
    if (!room) return false;
    return room.kind === "room" || room.a === visitorId || room.b === visitorId;
  }

  /** The seq that starts a window holding the last `count` messages of a room. */
  private windowStart(roomId: string, count: number): number {
    const row = this.one<{ seq: number }>(
      "SELECT seq FROM messages WHERE room = ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
      roomId, count - 1,
    );
    return row?.seq ?? 0;
  }

  openRoom(key: object, roomId: string): HubResult {
    const conn = this.conn(key);
    if (!conn) return fail("Not connected.");
    const room = this.room(roomId);
    if (!this.canAccess(conn.visitorId, room)) return fail("That conversation isn't available.");
    conn.roomId = room.id;
    conn.oldestSeq = this.windowStart(room.id, PAGE);
    const s = conn.state;
    s.screen = "thread";
    s.draft = "";
    s.pickerFor = "";
    s.pickerOpen = false;
    s.notice = "";
    if (s.toast.show && s.toast.roomId === room.id) s.toast = { ...EMPTY_TOAST };
    this.renderHeader(conn);
    this.markRead(conn.visitorId, room.id);
    this.renderThread(conn);
    this.renderTypingFor(conn);
    return OK;
  }

  closeRoom(key: object): void {
    const conn = this.conn(key);
    if (!conn) return;
    const room = conn.roomId;
    conn.roomId = null;
    conn.state.screen = "list";
    conn.state.room = { ...EMPTY_ROOM };
    conn.state.messages = [];
    conn.state.pickerFor = "";
    conn.state.pickerOpen = false;
    conn.state.typingText = "";
    conn.state.isTyping = false;
    if (room) this.stopTyping(conn.visitorId, room);
    this.renderConversations(conn);
  }

  createRoom(key: object, slug: string): HubResult {
    const conn = this.conn(key);
    if (!conn) return fail("Not connected.");
    if (!this.room(`r:${slug}`)) {
      if (!this.allow(conn.visitorId, "room")) return fail("You're creating rooms too fast — try again later.");
      const now = Date.now();
      this.q(
        "INSERT INTO rooms (id, kind, title, created_by, created, last_at) VALUES (?, 'room', ?, ?, ?, ?)",
        `r:${slug}`, slug, conn.visitorId, now, now,
      );
      for (const c of this.conns.values()) this.renderConversations(c);
    }
    return this.openRoom(key, `r:${slug}`);
  }

  openDm(key: object, otherId: string): HubResult {
    const conn = this.conn(key);
    if (!conn) return fail("Not connected.");
    if (otherId === conn.visitorId || !this.visitor(otherId)) return fail("That person isn't available.");
    const id = dmId(conn.visitorId, otherId);
    if (!this.room(id)) {
      const [a, b] = conn.visitorId < otherId ? [conn.visitorId, otherId] : [otherId, conn.visitorId];
      this.q("INSERT INTO rooms (id, kind, title, a, b, created_by, created, last_at) VALUES (?, 'dm', '', ?, ?, ?, ?, 0)",
        id, a, b, conn.visitorId, Date.now());
    }
    return this.openRoom(key, id);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** Advance a visitor's read pointer to the room's newest message. */
  private markRead(visitorId: string, roomId: string): void {
    const max = this.one<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM messages WHERE room = ?", roomId)?.seq ?? 0;
    const prev = this.one<{ seq: number }>("SELECT seq FROM reads WHERE room = ? AND visitor = ?", roomId, visitorId)?.seq ?? -1;
    if (prev >= max) return;
    this.q(
      "INSERT INTO reads (room, visitor, seq) VALUES (?, ?, ?) ON CONFLICT(room, visitor) DO UPDATE SET seq = excluded.seq",
      roomId, visitorId, max,
    );
    for (const c of this.conns.values()) {
      if (c.visitorId === visitorId) this.renderConversations(c);
      else if (c.roomId === roomId) this.renderThread(c); // their "Seen" receipt changed
    }
  }

  loadOlder(key: object): void {
    const conn = this.conn(key);
    if (!conn?.roomId || !conn.state.hasMore) return;
    const room = conn.roomId;
    const row = this.one<{ seq: number }>(
      "SELECT seq FROM messages WHERE room = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
      room, conn.oldestSeq, OLDER_PAGE - 1,
    );
    const oldest = row?.seq ?? this.one<{ seq: number }>("SELECT MIN(seq) AS seq FROM messages WHERE room = ?", room)?.seq ?? 0;
    const newest = this.one<{ seq: number }>("SELECT MAX(seq) AS seq FROM messages WHERE room = ?", room)?.seq ?? 0;
    // Never hold more than WINDOW_CAP rows.
    const capped = this.one<{ seq: number }>(
      "SELECT seq FROM messages WHERE room = ? AND seq <= ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
      room, newest, WINDOW_CAP - 1,
    )?.seq;
    conn.oldestSeq = capped !== undefined ? Math.max(oldest, capped) : oldest;
    this.renderThread(conn);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  send(key: object, text: string): HubResult {
    const conn = this.conn(key);
    if (!conn?.roomId) return fail("Open a conversation first.");
    const room = this.room(conn.roomId);
    if (!this.canAccess(conn.visitorId, room)) return fail("That conversation isn't available.");
    if (!this.allow(conn.visitorId, "message")) return fail("Slow down a little — you're sending messages too fast.");
    const id = crypto.randomUUID();
    const url = firstUrl(text);
    this.insertMessage(room.id, conn.visitorId, { id, kind: "text", body: text });
    if (url) void this.attachPreview(room.id, id, url);
    return OK;
  }

  postImage(key: object, roomId: string, bytes: Uint8Array): HubResult {
    const conn = this.conn(key);
    if (!conn) return fail("Not connected.");
    const room = this.room(roomId);
    if (!this.canAccess(conn.visitorId, room)) return fail("That conversation isn't available.");
    if (bytes.byteLength > LIMITS.imageBytes) return fail("That image is over 1 MB.");
    const type = sniffImage(bytes);
    if (!type) return fail("Only PNG, JPEG, GIF and WebP images can be sent.");
    if (!this.allow(conn.visitorId, "image")) return fail("One image every few seconds, please.");
    const imageId = crypto.randomUUID();
    this.q("INSERT INTO images (id, type, bytes, created) VALUES (?, ?, ?, ?)", imageId, type, bytes, Date.now());
    this.insertMessage(room.id, conn.visitorId, { id: crypto.randomUUID(), kind: "image", image: imageId });
    // Global image cap: drop the oldest and mark their messages.
    const excess = this.q<{ id: string }>(
      "SELECT id FROM images ORDER BY created DESC LIMIT -1 OFFSET ?", IMAGE_CAP,
    );
    for (const { id } of excess) {
      this.q("DELETE FROM images WHERE id = ?", id);
      this.q("UPDATE messages SET kind = 'text', body = '(image expired)', image = '' WHERE image = ?", id);
    }
    return OK;
  }

  image(id: string): { type: string; bytes: ArrayBuffer } | undefined {
    return this.one<{ type: string; bytes: ArrayBuffer }>("SELECT type, bytes FROM images WHERE id = ?", id);
  }

  private insertMessage(
    roomId: string,
    author: string,
    msg: { id: string; kind: "text" | "image"; body?: string; image?: string },
  ): void {
    const now = Date.now();
    this.q(
      "INSERT INTO messages (id, room, author, kind, body, image, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
      msg.id, roomId, author, msg.kind, msg.body ?? "", msg.image ?? "", now,
    );
    this.q("UPDATE rooms SET last_at = ? WHERE id = ?", now, roomId);
    this.trimHistory(roomId);
    this.stopTyping(author, roomId, false);

    // Everyone looking at the room (including the author) has now read it.
    const seq = this.one<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", msg.id)!.seq;
    const viewers = new Set<string>([author]);
    for (const c of this.conns.values()) if (c.roomId === roomId) viewers.add(c.visitorId);
    for (const v of viewers) {
      this.q(
        "INSERT INTO reads (room, visitor, seq) VALUES (?, ?, ?) ON CONFLICT(room, visitor) DO UPDATE SET seq = MAX(seq, excluded.seq)",
        roomId, v, seq,
      );
    }

    const room = this.room(roomId)!;
    const authorRow = this.visitor(author);
    for (const c of this.conns.values()) {
      if (!this.canAccess(c.visitorId, room)) continue;
      if (c.roomId === roomId) {
        this.renderThread(c);
        this.renderTypingFor(c);
      }
      this.renderConversations(c);
      if (room.kind === "dm" && c.visitorId !== author && c.roomId !== roomId && authorRow) {
        this.showToast(c, {
          roomId,
          title: authorRow.name,
          text: msg.kind === "image" ? "📷 Photo" : (msg.body ?? ""),
          initial: initialOf(authorRow.name),
          color: authorRow.color,
        });
      }
    }
  }

  private trimHistory(roomId: string): void {
    const cutoff = this.one<{ seq: number }>(
      "SELECT seq FROM messages WHERE room = ? ORDER BY seq DESC LIMIT 1 OFFSET ?", roomId, HISTORY_CAP,
    )?.seq;
    if (cutoff === undefined) return;
    const old = this.q<{ id: string; image: string }>("SELECT id, image FROM messages WHERE room = ? AND seq <= ?", roomId, cutoff);
    for (const m of old) {
      this.q("DELETE FROM reactions WHERE message_id = ?", m.id);
      if (m.image) this.q("DELETE FROM images WHERE id = ?", m.image);
    }
    this.q("DELETE FROM messages WHERE room = ? AND seq <= ?", roomId, cutoff);
  }

  private async attachPreview(roomId: string, messageId: string, url: string): Promise<void> {
    const preview: LinkPreview | null = await fetchPreview(url);
    if (!preview) return;
    this.q("UPDATE messages SET preview = ? WHERE id = ?", JSON.stringify(preview), messageId);
    for (const c of this.conns.values()) if (c.roomId === roomId) this.renderThread(c);
  }

  react(key: object, messageId: string, emoji: string): HubResult {
    const conn = this.conn(key);
    if (!conn) return fail("Not connected.");
    if (!(REACTIONS as readonly string[]).includes(emoji)) return fail("Unknown reaction.");
    const msg = this.one<{ room: string }>("SELECT room FROM messages WHERE id = ?", messageId);
    if (!msg || !this.canAccess(conn.visitorId, this.room(msg.room))) return fail("That message is gone.");
    if (!this.allow(conn.visitorId, "react")) return fail("Easy on the reactions!");
    const had = this.one("SELECT 1 AS x FROM reactions WHERE message_id = ? AND visitor = ? AND emoji = ?", messageId, conn.visitorId, emoji);
    if (had) this.q("DELETE FROM reactions WHERE message_id = ? AND visitor = ? AND emoji = ?", messageId, conn.visitorId, emoji);
    else this.q("INSERT INTO reactions (message_id, visitor, emoji) VALUES (?, ?, ?)", messageId, conn.visitorId, emoji);
    for (const c of this.conns.values()) if (c.roomId === msg.room) this.renderThread(c);
    return OK;
  }

  // -------------------------------------------------------------------------
  // Typing
  // -------------------------------------------------------------------------

  typingPing(key: object, hasText: boolean): void {
    const conn = this.conn(key);
    if (!conn?.roomId) return;
    if (!hasText) {
      this.stopTyping(conn.visitorId, conn.roomId);
      return;
    }
    let who = this.typing.get(conn.roomId);
    if (!who) this.typing.set(conn.roomId, (who = new Map()));
    const was = who.has(conn.visitorId);
    who.set(conn.visitorId, Date.now() + TYPING_MS);
    if (!was) this.renderTyping(conn.roomId);
  }

  private stopTyping(visitorId: string, roomId: string, render = true): void {
    const who = this.typing.get(roomId);
    if (who?.delete(visitorId) && render) this.renderTyping(roomId);
  }

  private renderTyping(roomId: string): void {
    for (const c of this.conns.values()) if (c.roomId === roomId) this.renderTypingFor(c);
  }

  private renderTypingFor(c: Conn): void {
    const names: string[] = [];
    for (const v of this.typing.get(c.roomId ?? "")?.keys() ?? []) {
      if (v === c.visitorId) continue;
      const row = this.visitor(v);
      if (row) names.push(row.name);
    }
    const text =
      names.length === 0 ? "" :
      names.length === 1 ? `${names[0]} is typing…` :
      names.length === 2 ? `${names[0]} and ${names[1]} are typing…` :
      "Several people are typing…";
    if (c.state.typingText !== text) c.state.typingText = text;
    if (c.state.isTyping !== (text !== "")) c.state.isTyping = text !== "";
  }

  // -------------------------------------------------------------------------
  // Toasts (in-app notification for DMs that arrive elsewhere)
  // -------------------------------------------------------------------------

  private showToast(c: Conn, t: { roomId: string; title: string; text: string; initial: string; color: string }): void {
    const text = [...t.text].length > 80 ? [...t.text].slice(0, 79).join("") + "…" : t.text;
    c.state.toast = { show: true, ...t, text };
    if (c.toastTimer) clearTimeout(c.toastTimer);
    c.toastTimer = setTimeout(() => {
      c.toastTimer = null;
      if (this.conns.get(c.key) === c && c.state.toast.show) c.state.toast = { ...EMPTY_TOAST };
    }, TOAST_MS);
  }

  dismissToast(key: object): void {
    const c = this.conn(key);
    if (c) c.state.toast = { ...EMPTY_TOAST };
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private renderHeader(c: Conn): void {
    const room = this.room(c.roomId);
    if (!room) return;
    c.state.room = this.header(c, room);
  }

  private header(c: Conn, room: RoomRow): RoomHeader {
    if (room.kind === "room") {
      const online = this.onlineVisitors().size;
      return {
        id: room.id,
        isRoom: true,
        title: `#${room.title}`,
        subtitle: `${ROOM_TOPICS[room.title] ?? "Public room"} · ${online} online`,
        initial: "#",
        color: "#334155",
        online: false,
      };
    }
    const otherId = room.a === c.visitorId ? room.b : room.a;
    const other = this.visitor(otherId);
    const online = this.isOnline(otherId);
    const name = other?.name ?? "Someone";
    return {
      id: room.id,
      isRoom: false,
      title: name,
      subtitle: online ? "Online" : other ? `Last seen ${agoLabel(other.last_seen, Date.now())}` : "Offline",
      initial: initialOf(name),
      color: other?.color ?? "#94A3B8",
      online,
    };
  }

  private renderConversations(c: Conn): void {
    if (!this.visitor(c.visitorId)) return;
    const now = Date.now();
    const rows = this.q<RoomRow & { created_by: string; unread: number; last_body: string | null; last_kind: string | null; last_author: string | null; last_created: number | null }>(
      `SELECT r.id, r.kind, r.title, r.a, r.b, r.last_at, r.created_by,
         (SELECT COUNT(*) FROM messages m WHERE m.room = r.id AND m.author != ?
            AND m.seq > COALESCE((SELECT seq FROM reads WHERE room = r.id AND visitor = ?), 0)) AS unread,
         lm.body AS last_body, lm.kind AS last_kind, lm.author AS last_author, lm.created AS last_created
       FROM rooms r
       LEFT JOIN messages lm ON lm.seq = (SELECT MAX(seq) FROM messages WHERE room = r.id)
       WHERE r.kind = 'room' OR r.a = ? OR r.b = ?
       ORDER BY r.last_at DESC, r.title ASC`,
      c.visitorId, c.visitorId, c.visitorId, c.visitorId,
    );
    const names = new Map<string, VisitorRow | undefined>();
    const who = (id: string) => {
      if (!names.has(id)) names.set(id, this.visitor(id));
      return names.get(id);
    };
    let total = 0;
    const list: ConversationView[] = [];
    for (const r of rows) {
      // DMs show up once a message exists or the visitor started them.
      if (r.kind === "dm" && !r.last_created && r.created_by !== c.visitorId) continue;
      const unread = Number(r.unread) || 0;
      total += unread;
      let title: string, initial: string, color: string, online = false;
      if (r.kind === "room") {
        title = `#${r.title}`;
        initial = "#";
        color = "#334155";
      } else {
        const other = who(r.a === c.visitorId ? r.b : r.a);
        title = other?.name ?? "Someone";
        initial = initialOf(title);
        color = other?.color ?? "#94A3B8";
        online = !!other && this.isOnline(other.id);
      }
      let preview = r.kind === "room" ? ROOM_TOPICS[r.title] ?? "No messages yet" : "Say hello 👋";
      if (r.last_created) {
        const body = r.last_kind === "image" ? "📷 Photo" : (r.last_body ?? "").replace(/\s+/g, " ");
        const by = r.last_author === c.visitorId ? "You" : r.kind === "room" ? who(r.last_author ?? "")?.name ?? "" : "";
        preview = by ? `${by}: ${body}` : body;
      }
      list.push({
        id: r.id,
        isRoom: r.kind === "room",
        title,
        initial,
        color,
        preview: [...preview].length > 70 ? [...preview].slice(0, 69).join("") + "…" : preview,
        time: r.last_created ? listTime(r.last_created, now, c.tz) : "",
        unread,
        hasUnread: unread > 0,
        unreadLabel: unread > 99 ? "99+" : String(unread),
        online,
      });
    }
    c.state.conversations = list;
    c.state.unreadTotal = total;
  }

  private renderPeople(c: Conn): void {
    const now = Date.now();
    const online = this.onlineVisitors();
    const recent = this.q<VisitorRow>(
      "SELECT id, name, color, last_seen FROM visitors WHERE id != ? AND last_seen > ? ORDER BY last_seen DESC LIMIT 30",
      c.visitorId, now - 7 * 86_400_000,
    );
    const people: PersonView[] = recent
      .map((v) => ({
        id: v.id,
        name: v.name,
        initial: initialOf(v.name),
        color: v.color,
        online: online.has(v.id),
        status: online.has(v.id) ? "Online" : `Last seen ${agoLabel(v.last_seen, now)}`,
      }))
      .sort((x, y) => Number(y.online) - Number(x.online));
    c.state.people = people;
    c.state.hasPeople = people.length > 0;
    c.state.onlineCount = [...online].filter((v) => v !== c.visitorId).length;
    if (c.roomId?.startsWith("r:")) this.renderHeader(c);
  }

  private renderThread(c: Conn): void {
    const roomId = c.roomId;
    if (!roomId) return;
    const room = this.room(roomId);
    if (!room) return;
    const now = Date.now();
    const rows = this.q<{
      seq: number; id: string; author: string; kind: string; body: string; image: string; preview: string; created: number;
      name: string | null; color: string | null;
    }>(
      `SELECT m.seq, m.id, m.author, m.kind, m.body, m.image, m.preview, m.created, v.name, v.color
       FROM messages m LEFT JOIN visitors v ON v.id = m.author
       WHERE m.room = ? AND m.seq >= ? ORDER BY m.seq ASC LIMIT ?`,
      roomId, c.oldestSeq, WINDOW_CAP + OLDER_PAGE,
    );
    const reactions = this.q<{ message_id: string; emoji: string; visitor: string }>(
      `SELECT r.message_id, r.emoji, r.visitor FROM reactions r JOIN messages m ON m.id = r.message_id
       WHERE m.room = ? AND m.seq >= ?`,
      roomId, c.oldestSeq,
    );
    const reads = this.q<{ visitor: string; seq: number; name: string | null }>(
      "SELECT r.visitor, r.seq, v.name FROM reads r LEFT JOIN visitors v ON v.id = r.visitor WHERE r.room = ? AND r.visitor != ?",
      roomId, c.visitorId,
    );
    const hasMore = !!this.one("SELECT 1 AS x FROM messages WHERE room = ? AND seq < ? LIMIT 1", roomId, c.oldestSeq);

    const byMessage = new Map<string, Map<string, { count: number; mine: boolean }>>();
    for (const r of reactions) {
      let m = byMessage.get(r.message_id);
      if (!m) byMessage.set(r.message_id, (m = new Map()));
      const e = m.get(r.emoji) ?? { count: 0, mine: false };
      e.count++;
      if (r.visitor === c.visitorId) e.mine = true;
      m.set(r.emoji, e);
    }

    let lastMineSeq = -1;
    for (const r of rows) if (r.author === c.visitorId) lastMineSeq = r.seq;
    let status = "";
    if (lastMineSeq >= 0) {
      const seen = reads.filter((r) => r.seq >= lastMineSeq && r.name);
      if (room.kind === "dm") {
        const otherId = room.a === c.visitorId ? room.b : room.a;
        status = seen.length > 0 ? "Seen" : this.isOnline(otherId) ? "Delivered" : "Sent";
      } else if (seen.length > 0) {
        const names = seen.map((r) => r.name!);
        status = `Seen by ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
      } else {
        status = "Sent";
      }
    }

    const out: MessageView[] = [];
    let prevDay = "";
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const prev = rows[i - 1];
      const next = rows[i + 1];
      const day = dayKey(r.created, c.tz);
      if (day !== prevDay) {
        out.push(dayRow(`day-${day}`, dayLabel(r.created, now, c.tz)));
        prevDay = day;
      }
      const first = !prev || prev.author !== r.author || r.created - prev.created > GROUP_GAP_MS || dayKey(prev.created, c.tz) !== day;
      const last = !next || next.author !== r.author || next.created - r.created > GROUP_GAP_MS || dayKey(next.created, c.tz) !== day;
      const mine = r.author === c.visitorId;
      const big = "18px", small = "5px";
      const radius = mine
        ? `${big} ${first ? big : small} ${last ? big : small} ${big}`
        : `${first ? big : small} ${big} ${big} ${last ? big : small}`;
      const name = r.name ?? "Someone";
      let preview: LinkPreview | null = null;
      if (r.preview) {
        try {
          preview = JSON.parse(r.preview) as LinkPreview;
        } catch {
          preview = null;
        }
      }
      const rx = byMessage.get(r.id);
      const reactionViews = rx
        ? [...rx.entries()].map(([emoji, v]) => ({ key: `${r.id}-${emoji}`, emoji, label: `${emoji} ${v.count}`, mine: v.mine }))
        : [];
      out.push({
        id: r.id,
        isDay: false,
        dayLabel: "",
        mine,
        author: name,
        initial: initialOf(name),
        color: r.color ?? "#94A3B8",
        text: r.body,
        hasText: r.kind === "text" && r.body !== "",
        time: clockTime(r.created, c.tz),
        showName: !mine && first && room.kind === "room",
        showAvatar: !mine && last,
        showTime: last,
        radius,
        gapTop: first ? 10 : 2,
        hasImage: r.kind === "image" && !!r.image,
        image: r.image ? `/img/${r.image}` : "",
        hasPreview: !!preview,
        previewUrl: preview?.url ?? "",
        previewSite: preview?.site ?? "",
        previewTitle: preview?.title ?? "",
        previewDesc: preview?.description ?? "",
        hasPreviewImage: !!preview?.image,
        previewImage: preview?.image ?? "",
        reactions: reactionViews,
        hasReactions: reactionViews.length > 0,
        showStatus: r.seq === lastMineSeq && status !== "",
        status: r.seq === lastMineSeq ? status : "",
        selected: c.state.pickerFor === r.id,
      });
    }
    c.state.messages = out;
    c.state.hasMore = hasMore;
    c.state.isEmpty = rows.length === 0;
  }

  /** Re-render one connection's thread (e.g. after the picker selection changed). */
  refreshThread(key: object): void {
    const c = this.conn(key);
    if (c) this.renderThread(c);
  }

  roomOf(key: object): string | null {
    return this.conn(key)?.roomId ?? null;
  }

  visitorOf(key: object): string | null {
    return this.conn(key)?.visitorId ?? null;
  }
}

function dmIdOrNull(a: string, b: string): string | null {
  return a === b ? null : dmId(a, b);
}

function dayRow(id: string, label: string): MessageView {
  return {
    id,
    isDay: true,
    dayLabel: label,
    mine: false,
    author: "",
    initial: "",
    color: "",
    text: "",
    hasText: false,
    time: "",
    showName: false,
    showAvatar: false,
    showTime: false,
    radius: "",
    gapTop: 12,
    hasImage: false,
    image: "",
    hasPreview: false,
    previewUrl: "",
    previewSite: "",
    previewTitle: "",
    previewDesc: "",
    hasPreviewImage: false,
    previewImage: "",
    reactions: [],
    hasReactions: false,
    showStatus: false,
    status: "",
    selected: false,
  };
}

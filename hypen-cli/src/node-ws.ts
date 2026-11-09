/**
 * Minimal RFC 6455 WebSocket server for the Node fallback dev server.
 *
 * Node has a WebSocket *client* built in but no server, and the CLI
 * deliberately carries no `ws` dependency. The dev server only needs the
 * small subset the Hypen remote protocol uses: text (and binary) messages,
 * fragmentation, ping/pong and the close handshake — no extensions
 * (permessage-deflate is simply not negotiated, which every client accepts).
 */

import { createHash } from "crypto";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Default cap on one (reassembled) message: matches RemoteServer's 4 MiB. */
export const DEFAULT_MAX_PAYLOAD = 4 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** Encode one unmasked (server → client) frame. */
export function encodeFrame(opcode: number, payload: Uint8Array, fin = true): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** Bytes consumed from the input buffer. */
  length: number;
}

/**
 * Parse one frame from the front of `buf`. Returns `null` when more bytes
 * are needed. Throws on protocol violations (unmasked client frame,
 * oversize payload).
 */
export function parseFrame(buf: Buffer, maxPayload = DEFAULT_MAX_PAYLOAD): ParsedFrame | null {
  if (buf.length < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(maxPayload)) throw new WsProtocolError(1009, "Message too big");
    len = Number(big);
    offset = 10;
  }
  if (len > maxPayload) throw new WsProtocolError(1009, "Message too big");
  if (!masked) throw new WsProtocolError(1002, "Client frames must be masked");
  if (buf.length < offset + 4 + len) return null;
  const mask = buf.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
  return { fin, opcode, payload, length: offset + len };
}

export class WsProtocolError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export interface NodeWebSocketHandlers {
  onMessage(data: string | Buffer): void;
  onClose(code: number, reason: string): void;
}

/** One accepted server-side WebSocket connection. */
export class NodeWebSocket {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closed = false;
  private closeNotified = false;
  private handlers: NodeWebSocketHandlers | null = null;

  constructor(
    private readonly socket: Duplex,
    private readonly maxPayload = DEFAULT_MAX_PAYLOAD,
    /** Bytes that arrived with the upgrade request (the `head` buffer). */
    initial?: Buffer
  ) {
    if (initial && initial.length) this.buffer = Buffer.from(initial);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.notifyClose(1006, ""));
    socket.on("error", () => this.notifyClose(1006, ""));
  }

  /** Attach handlers; bytes that arrived before this are delivered now. */
  listen(handlers: NodeWebSocketHandlers): void {
    this.handlers = handlers;
    this.drain();
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(data: string | Uint8Array): void {
    if (this.closed) return;
    const isText = typeof data === "string";
    const payload = isText ? Buffer.from(data, "utf-8") : data;
    this.socket.write(encodeFrame(isText ? OP_TEXT : OP_BINARY, payload));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.socket.write(encodeFrame(OP_CLOSE, body));
      this.socket.end();
    } catch {
      /* socket already gone */
    }
    // Give the peer a moment to answer the close, then drop the socket.
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
    this.notifyClose(code, reason);
  }

  private notifyClose(code: number, reason: string): void {
    this.closed = true;
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.handlers?.onClose(code, reason);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.handlers) this.drain();
  }

  private drain(): void {
    while (!this.closeNotified) {
      let frame: ParsedFrame | null;
      try {
        frame = parseFrame(this.buffer, this.maxPayload);
      } catch (err) {
        const e = err as WsProtocolError;
        this.close(e.code ?? 1002, e.message);
        return;
      }
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.length);
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: ParsedFrame): void {
    switch (frame.opcode) {
      case OP_PING:
        if (!this.closed) this.socket.write(encodeFrame(OP_PONG, frame.payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf-8") : "";
        if (!this.closed) {
          // Echo the close, then end the TCP stream.
          this.closed = true;
          try {
            this.socket.write(encodeFrame(OP_CLOSE, frame.payload.subarray(0, 2)));
            this.socket.end();
          } catch {
            /* gone */
          }
        }
        this.notifyClose(code, reason);
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
      case OP_CONT: {
        if (frame.opcode !== OP_CONT) {
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = frame.opcode;
        }
        this.fragments.push(frame.payload);
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > this.maxPayload) {
          this.close(1009, "Message too big");
          return;
        }
        if (!frame.fin) return;
        const data = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        this.handlers?.onMessage(
          this.fragmentOpcode === OP_TEXT ? data.toString("utf-8") : data
        );
        return;
      }
      default:
        this.close(1002, "Unknown opcode");
    }
  }
}

/**
 * Complete the server side of the opening handshake on an HTTP `upgrade`
 * event. Returns the open connection, or `null` (after answering 400) for
 * requests that are not valid WebSocket upgrades.
 */
export function acceptUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  maxPayload = DEFAULT_MAX_PAYLOAD
): NodeWebSocket | null {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || !key) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  (socket as any).setNoDelay?.(true);
  return new NodeWebSocket(socket, maxPayload, head);
}

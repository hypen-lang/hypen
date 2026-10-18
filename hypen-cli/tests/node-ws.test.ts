import { describe, expect, test } from "bun:test";
import { PassThrough } from "stream";
import {
  acceptKey,
  encodeFrame,
  parseFrame,
  NodeWebSocket,
  WsProtocolError,
} from "../src/node-ws";

/** Client → server frame (masked, as RFC 6455 requires). */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0, 0x80 | len]);
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
  return Buffer.concat([header, mask, body]);
}

describe("node-ws framing", () => {
  test("acceptKey matches the RFC 6455 example", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  test("parses masked frames of every length class", () => {
    for (const size of [0, 5, 125, 126, 300, 70_000]) {
      const payload = Buffer.alloc(size, 0x61);
      const parsed = parseFrame(clientFrame(0x1, payload));
      expect(parsed?.fin).toBe(true);
      expect(parsed?.opcode).toBe(0x1);
      expect(parsed?.payload.equals(payload)).toBe(true);
    }
  });

  test("returns null on partial input", () => {
    const frame = clientFrame(0x1, Buffer.from("hello world"));
    expect(parseFrame(frame.subarray(0, 1))).toBeNull();
    expect(parseFrame(frame.subarray(0, frame.length - 1))).toBeNull();
  });

  test("rejects unmasked client frames and oversize payloads", () => {
    expect(() => parseFrame(encodeFrame(0x1, Buffer.from("x")))).toThrow(WsProtocolError);
    expect(() => parseFrame(clientFrame(0x1, Buffer.alloc(200)), 100)).toThrow(/too big/);
  });

  test("encodes unmasked server frames", () => {
    const f = encodeFrame(0x1, Buffer.from("hi"));
    expect([...f]).toEqual([0x81, 2, 0x68, 0x69]);
    expect(encodeFrame(0x2, Buffer.alloc(300))[1]).toBe(126);
  });
});

describe("NodeWebSocket", () => {
  function setup() {
    const socket = new PassThrough();
    const written: Buffer[] = [];
    socket.write = ((chunk: Buffer) => {
      written.push(Buffer.from(chunk));
      return true;
    }) as any;
    const ws = new NodeWebSocket(socket as any);
    const messages: Array<string | Buffer> = [];
    const closes: number[] = [];
    ws.listen({ onMessage: (m) => messages.push(m), onClose: (c) => closes.push(c) });
    return { socket, ws, written, messages, closes };
  }

  test("delivers text messages, reassembling fragments split across chunks", () => {
    const { socket, messages } = setup();
    const whole = Buffer.concat([
      clientFrame(0x1, Buffer.from('{"type":'), false),
      clientFrame(0x0, Buffer.from('"hello"}'), true),
    ]);
    socket.emit("data", whole.subarray(0, 7));
    socket.emit("data", whole.subarray(7));
    expect(messages).toEqual(['{"type":"hello"}']);
  });

  test("answers pings and echoes close", () => {
    const { socket, written, closes } = setup();
    socket.emit("data", clientFrame(0x9, Buffer.from("p")));
    expect(written[0]![0]).toBe(0x8a); // FIN + pong
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000, 0);
    socket.emit("data", clientFrame(0x8, code));
    expect(written[1]![0]).toBe(0x88); // FIN + close
    expect(closes).toEqual([1000]);
  });

  test("send() writes text frames; close() notifies once", () => {
    const { ws, written, closes } = setup();
    ws.send("ok");
    expect([...written[0]!]).toEqual([0x81, 2, 0x6f, 0x6b]);
    ws.close(1012, "Hot reload");
    ws.close(1000);
    expect(closes).toEqual([1012]);
    expect(ws.isOpen).toBe(false);
  });

  test("bytes received with the upgrade request are not lost", () => {
    const socket = new PassThrough();
    const messages: Array<string | Buffer> = [];
    const ws = new NodeWebSocket(socket as any, undefined, clientFrame(0x1, Buffer.from("early")));
    ws.listen({ onMessage: (m) => messages.push(m), onClose: () => {} });
    expect(messages).toEqual(["early"]);
  });
});

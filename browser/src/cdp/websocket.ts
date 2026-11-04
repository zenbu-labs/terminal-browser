import crypto from "node:crypto";
import type net from "node:net";

import { ByteQueue } from "./byte-queue";

const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_HEADER_BYTES = 16 * 1024;
export interface CdpLimits {
  maxMessageBytes: number;
  // A client that leaves this much unread is dropped instead of growing memory.
  maxBacklogBytes: number;
  handshakeTimeoutMs: number;
  maxConnections: number;
  // Requests one client may have waiting on Chromium at once.
  maxPending: number;
}

export const DEFAULT_LIMITS: CdpLimits = {
  maxMessageBytes: 256 * 1024 * 1024,
  maxBacklogBytes: 64 * 1024 * 1024,
  handshakeTimeoutMs: 10_000,
  maxConnections: 64,
  maxPending: 10_000,
};

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface MessageSocket {
  send(text: string): void;
  close(): void;
  pause(): void;
  resume(): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseHeaders(head: string): { requestLine: string; headers: Map<string, string>; repeated: Set<string> } {
  const [requestLine, ...lines] = head.split("\r\n");
  const headers = new Map<string, string>();
  const repeated = new Set<string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (headers.has(name)) repeated.add(name);
    headers.set(name, line.slice(colon + 1).trim());
  }
  return { requestLine, headers, repeated };
}

export interface HttpAnswer {
  status: string;
  body: string;
}

export interface AcceptOptions {
  // Whether a request for `path` with these headers may be served at all.
  allow?: (path: string, headers: Map<string, string>) => boolean;
  // A reply to a plain GET (no WebSocket upgrade), or null to refuse it.
  answer?: (path: string) => Promise<HttpAnswer | null>;
}

// Accepts one WebSocket client on an already-connected stream. Requests that
// carry an Origin header come from a web page, so they are refused.
export function acceptWebSocket(
  socket: net.Socket,
  onOpen: (connection: MessageSocket) => void,
  limits: CdpLimits = DEFAULT_LIMITS,
  options: AcceptOptions = {},
): void {
  const { maxMessageBytes, maxBacklogBytes } = limits;
  let head: Buffer = Buffer.alloc(0);
  const queue = new ByteQueue();
  let open = false;
  let closed = false;
  const messageListeners: ((text: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;

  const finish = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    for (const listener of closeListeners) listener();
  };

  // The refusal is sent, then the connection is closed from our side, so a
  // client that never hangs up doesn't keep one of the connection slots.
  const refuse = (status: string) => {
    closed = true;
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };

  // Drops the client rather than queue a frame that would take its unread
  // backlog past the cap.
  const enqueue = (opcode: number, payload: Buffer) => {
    if (socket.writableLength + payload.length + 14 > maxBacklogBytes) {
      finish();
      return;
    }
    socket.write(frame(opcode, payload));
  };

  const connection: MessageSocket = {
    send(text) {
      if (!closed) enqueue(OP_TEXT, Buffer.from(text, "utf8"));
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
    close() {
      if (closed) return;
      socket.end(frame(OP_CLOSE, Buffer.alloc(0)));
      finish();
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
  };

  const handshakeTimer = setTimeout(() => {
    if (!open) finish();
  }, limits.handshakeTimeoutMs);
  socket.once("close", () => clearTimeout(handshakeTimer));

  const handshake = (): boolean => {
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > MAX_HEADER_BYTES) refuse("431 Request Header Fields Too Large");
      return false;
    }
    const { requestLine, headers, repeated } = parseHeaders(head.subarray(0, end).toString("latin1"));
    queue.push(head.subarray(end + 4));
    head = Buffer.alloc(0);
    if (repeated.has("host")) {
      refuse("400 Bad Request");
      return false;
    }
    const requestPath = requestLine.split(" ")[1] ?? "";
    if (headers.has("origin") || (options.allow && !options.allow(requestPath, headers))) {
      refuse("403 Forbidden");
      return false;
    }
    if (options.answer && requestLine.startsWith("GET ") && !headers.has("upgrade")) {
      closed = true;
      clearTimeout(handshakeTimer);
      void options.answer(requestPath).then((answer) => {
        const reply = answer ?? { status: "404 Not Found", body: "" };
        socket.end(
          `HTTP/1.1 ${reply.status}\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: ${Buffer.byteLength(reply.body)}\r\nConnection: close\r\n\r\n${reply.body}`,
          () => socket.destroy(),
        );
      });
      return false;
    }
    const key = headers.get("sec-websocket-key");
    if (
      !requestLine.startsWith("GET ") ||
      headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      headers.get("sec-websocket-version") !== "13" ||
      !key
    ) {
      refuse("400 Bad Request");
      return false;
    }
    const accept = crypto.createHash("sha1").update(key + HANDSHAKE_GUID).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    clearTimeout(handshakeTimer);
    open = true;
    onOpen(connection);
    return true;
  };

  const readFrames = () => {
    while (!closed) {
      if (queue.length < 2) return;
      const start = queue.peek(2);
      const first = start[0];
      const second = start[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0 || (second & 0x80) === 0) return finish();
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (queue.length < 4) return;
        length = queue.peek(4).readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (queue.length < 10) return;
        const long = queue.peek(10).readBigUInt64BE(2);
        if (long > BigInt(maxMessageBytes)) return finish();
        length = Number(long);
        offset = 10;
      }
      if (opcode >= OP_CLOSE && (!fin || length > 125)) return finish();
      if (length > maxMessageBytes || fragmentBytes + length > maxMessageBytes) return finish();
      if (queue.length < offset + 4 + length) return;
      queue.take(offset);
      const mask = queue.take(4);
      const payload = Buffer.from(queue.take(length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode === OP_CLOSE) {
        connection.close();
        return;
      }
      if (opcode === OP_PING) {
        enqueue(OP_PONG, payload);
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode !== OP_TEXT && opcode !== OP_BINARY && opcode !== OP_CONTINUATION) return finish();
      if ((opcode === OP_CONTINUATION) !== fragments.length > 0) return finish();
      fragmentBytes += payload.length;
      if (fragmentBytes > maxMessageBytes) return finish();
      fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      fragmentBytes = 0;
      for (const listener of messageListeners) listener(text);
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    if (open) {
      queue.push(chunk);
    } else {
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
      if (!handshake()) return;
    }
    readFrames();
  });
  socket.on("error", finish);
  socket.on("close", finish);
}

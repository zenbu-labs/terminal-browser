// Browser-level CDP client for the daemon's private CDP socket (a WebSocket on a Unix socket),
// the same channel `terminal-browser action` uses. Pages are reached through flat sessions.
import crypto from "node:crypto";
import net from "node:net";

function frame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function openWebSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const messageListeners = [];
    const closeListeners = [];
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    let fragments = [];
    const closed = () => { for (const listener of closeListeners.splice(0)) listener(); };
    const ws = {
      send: (text) => socket.write(frame(0x1, Buffer.from(text))),
      close: () => socket.destroy(),
      onMessage: (listener) => messageListeners.push(listener),
      onClose: (listener) => closeListeners.push(listener),
    };
    const readFrames = () => {
      while (buffered.length >= 2) {
        const fin = (buffered[0] & 0x80) !== 0;
        const opcode = buffered[0] & 0x0f;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffered.length < offset + length) return;
        const payload = buffered.subarray(offset, offset + length);
        buffered = buffered.subarray(offset + length);
        if (opcode === 0x8) { socket.destroy(); return; }
        if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
        if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) continue;
        fragments.push(Buffer.from(payload));
        if (!fin) continue;
        const text = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        for (const listener of messageListeners) listener(text);
      }
    };
    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffered.subarray(0, end).toString("latin1");
        buffered = buffered.subarray(end + 4);
        if (!head.startsWith("HTTP/1.1 101")) {
          socket.destroy();
          // fixme: placeholder copy
          reject(new Error(`CDP socket refused the connection: ${head.split("\r\n")[0]}`));
          return;
        }
        upgraded = true;
        resolve(ws);
      }
      readFrames();
    });
    socket.on("error", (error) => { if (!upgraded) reject(error); });
    socket.on("close", closed);
  });
}

export async function connectCdpSocket(socketPath, { timeoutMs = 30000 } = {}) {
  const ws = await openWebSocket(socketPath);
  let nextId = 1;
  const pending = new Map();
  const detachListeners = new Map();
  const fail = (sessionId, message) => {
    for (const [id, request] of pending) {
      if (sessionId !== undefined && request.sessionId !== sessionId) continue;
      pending.delete(id);
      request.resolve({ error: { message } });
    }
  };
  ws.onMessage((text) => {
    const msg = JSON.parse(text);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Target.detachedFromTarget") {
      // fixme: placeholder copy
      fail(msg.params.sessionId, "target closed");
      detachListeners.get(msg.params.sessionId)?.();
    }
  });
  ws.onClose(() => {
    // fixme: placeholder copy
    fail(undefined, "CDP socket closed");
    for (const listener of detachListeners.values()) listener();
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      // fixme: placeholder copy
      resolve({ error: { message: `${method} timed out` } });
    }, timeoutMs);
    pending.set(id, { sessionId, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return {
    send,
    onDetach: (sessionId, listener) => detachListeners.set(sessionId, () => {
      detachListeners.delete(sessionId);
      listener();
    }),
    close: () => ws.close(),
  };
}

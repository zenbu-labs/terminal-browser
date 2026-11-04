import net from "node:net";
import type { Duplex } from "node:stream";

import { listenPrivately, privateServer } from "@zenbu-labs/pixel/private-socket";
import type { PeerUidReader } from "@zenbu-labs/pixel/private-socket";
import { setCloseOnExec } from "@zenbu-labs/pixel/native";

import { serveDebuggingPort } from "./port";
import { CdpRelay } from "./relay";
import { DEFAULT_LIMITS, acceptWebSocket } from "./websocket";
import type { CdpLimits } from "./websocket";

const CHROMIUM_READ_FD = 3;
const CHROMIUM_WRITE_FD = 4;
const RELAY_FD = 5;

// The CLI starts the daemon with Chromium's debugging pipe on fds 3 and 4 and
// our end of it on fd 5. Children we spawn must not inherit any of them.
export function openDebuggingPipe(): net.Socket {
  for (const fd of [CHROMIUM_READ_FD, CHROMIUM_WRITE_FD, RELAY_FD]) setCloseOnExec(fd);
  return new net.Socket({ fd: RELAY_FD, readable: true, writable: true });
}

export function serveCdp(
  pipe: Duplex,
  socketPath: string,
  options: { read?: PeerUidReader; limits?: Partial<CdpLimits> } = {},
): { server: net.Server; openPort: (port: number) => Promise<{ server: net.Server; port: number }> } {
  const limits: CdpLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const relay = new CdpRelay(pipe, limits);
  const server = privateServer(
    (connection) => acceptWebSocket(connection, (socket) => relay.connect(socket), limits),
    options.read,
  );
  server.maxConnections = limits.maxConnections;
  server.on("error", (error) => process.stderr.write(`terminal-browser cdp socket error: ${error}\n`));
  listenPrivately(server, socketPath);
  return { server, openPort: (port) => serveDebuggingPort(relay, port, limits) };
}

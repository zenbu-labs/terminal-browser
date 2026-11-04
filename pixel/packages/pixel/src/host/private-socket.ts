import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { socketPeerUid } from "../react/native";
import { ensurePrivateDir, ownUid } from "../private-dir";

export type PeerUidReader = (fd: number) => number;

export function connectionUid(connection: net.Socket, read: PeerUidReader = socketPeerUid): number | null {
  const fd = (connection as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return null;
  try {
    return read(fd);
  } catch {
    return null;
  }
}

export function peerAllowed(peerUid: number | null, uid: number): boolean {
  return peerUid !== null && peerUid === uid;
}

// A Unix socket server that only talks to processes of the user running it.
export function privateServer(
  onConnection: (connection: net.Socket) => void,
  read: PeerUidReader = socketPeerUid,
): net.Server {
  const uid = ownUid();
  return net.createServer((connection) => {
    if (!peerAllowed(connectionUid(connection, read), uid)) {
      connection.destroy();
      return;
    }
    onConnection(connection);
  });
}

// The socket is created 0600 inside a 0700 directory whatever the umask is;
// Node binds synchronously inside listen(), so the umask covers the bind.
// Returns the socket's real path, which is what clients should be given.
export function listenPrivately(server: net.Server, socketPath: string): string {
  const real = privateSocketPath(socketPath);
  fs.rmSync(real, { force: true });
  const umask = process.umask(0o177);
  try {
    server.listen(real);
  } finally {
    process.umask(umask);
  }
  if (server.address() !== null) fs.chmodSync(real, 0o600);
  return real;
}

// The socket's path with its folder checked and resolved, so a link on the way
// can't be swapped between the check and the connect.
export function privateSocketPath(socketPath: string): string {
  return path.join(ensurePrivateDir(path.dirname(socketPath)), path.basename(socketPath));
}

export class UntrustedSocketError extends Error {
  constructor(socketPath: string) {
    // fixme: placeholder copy
    super(`Refusing to talk to ${socketPath}: it is served by another user`);
  }
}

// Connects to a socket made by listenPrivately, and only resolves once the
// kernel says the process at the other end runs as our user.
export function connectPrivately(socketPath: string, read: PeerUidReader = socketPeerUid): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let real: string;
    try {
      real = privateSocketPath(socketPath);
    } catch (error) {
      reject(error);
      return;
    }
    const socket = net.connect(real);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      if (!peerAllowed(connectionUid(socket, read), ownUid())) {
        socket.destroy();
        reject(new UntrustedSocketError(real));
        return;
      }
      resolve(socket);
    });
  });
}

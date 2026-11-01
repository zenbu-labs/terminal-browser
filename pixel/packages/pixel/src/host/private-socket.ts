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
export function listenPrivately(server: net.Server, socketPath: string): void {
  ensurePrivateDir(path.dirname(socketPath));
  fs.rmSync(socketPath, { force: true });
  const umask = process.umask(0o177);
  try {
    server.listen(socketPath);
  } finally {
    process.umask(umask);
  }
  if (server.address() !== null) fs.chmodSync(socketPath, 0o600);
}

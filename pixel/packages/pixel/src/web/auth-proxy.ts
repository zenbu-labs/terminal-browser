import crypto from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";

const MAX_HEAD_BYTES = 64 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 512;

export interface AuthProxy {
  port: number;
  username: string;
  password: string;
  // Keeps the port taken but answers every request with 502, so a page still
  // pointed at it never reaches whoever would bind the port next.
  retire(): void;
  close(): void;
}

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hostPort(target: string, defaultPort: number): { host: string; port: number } | null {
  const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(target);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : defaultPort;
  return port > 0 && port < 65536 ? { host: match[1], port } : null;
}

export type Upstream = (host: string, port: number) => Duplex;

const HOP_BY_HOP = ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "upgrade"];

// An HTTP proxy on loopback that only serves requests carrying a random
// password, and opens each connection it forwards with `open`. Every request
// on a kept-alive connection is checked and stripped on its own, and each one
// gets its own upstream, so the password never reaches the remote side.
export function startAuthProxy(
  open: Upstream,
  limits = { headTimeoutMs: HEAD_TIMEOUT_MS, maxConnections: MAX_CONNECTIONS },
): Promise<AuthProxy> {
  const username = "terminal-browser";
  const password = crypto.randomBytes(24).toString("hex");
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const authorized = (request: http.IncomingMessage) => sameSecret(request.headers["proxy-authorization"], expected);
  let retired = false;
  const server = http.createServer(
    {
      headersTimeout: limits.headTimeoutMs,
      requestTimeout: limits.headTimeoutMs * 6,
      connectionsCheckingInterval: Math.min(1000, limits.headTimeoutMs),
      maxHeaderSize: MAX_HEAD_BYTES,
    },
    (request, response) => {
      if (retired) {
        response.writeHead(502, { connection: "close" }).end();
        return;
      }
      if (!authorized(request)) {
        response.writeHead(407, { "proxy-authenticate": 'Basic realm="terminal-browser"' }).end();
        return;
      }
      let url: URL | null = null;
      try {
        url = new URL(request.url ?? "");
      } catch {}
      const destination = url?.protocol === "http:" ? hostPort(url.host, 80) : null;
      if (!url || !destination) {
        response.writeHead(400).end();
        return;
      }
      let upstream: Duplex;
      try {
        upstream = open(destination.host, destination.port);
      } catch {
        response.writeHead(502).end();
        return;
      }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_BY_HOP.includes(name) && value !== undefined) headers[name] = value;
      }
      headers.connection = "close";
      const forwarded = http.request(
        {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          createConnection: () => upstream as never,
        },
        (reply) => {
          const replyHeaders: http.OutgoingHttpHeaders = {};
          for (const [name, value] of Object.entries(reply.headers)) {
            if (!HOP_BY_HOP.includes(name) && value !== undefined) replyHeaders[name] = value;
          }
          response.writeHead(reply.statusCode ?? 502, replyHeaders);
          reply.pipe(response);
        },
      );
      forwarded.on("error", () => {
        if (!response.headersSent) response.writeHead(502).end();
        else response.destroy();
      });
      response.on("close", () => upstream.destroy());
      request.pipe(forwarded);
    },
  );
  server.on("connect", (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => {});
    if (retired) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (!authorized(request)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="terminal-browser"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const destination = hostPort(request.url ?? "", 443);
    let upstream: Duplex | null = null;
    try {
      if (destination) upstream = open(destination.host, destination.port);
    } catch {}
    if (!upstream) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const tunnel = upstream;
    tunnel.on("error", () => client.destroy());
    client.on("close", () => tunnel.destroy());
    tunnel.on("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) tunnel.write(head);
    client.pipe(tunnel);
    tunnel.pipe(client);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.maxConnections = limits.maxConnections;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("proxy has no port"));
        return;
      }
      resolve({
        port: address.port,
        username,
        password,
        retire: () => {
          retired = true;
          server.closeIdleConnections();
        },
        close: () => {
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

import net from "node:net";

import type { CdpRelay } from "./relay";
import { acceptWebSocket } from "./websocket";
import type { CdpLimits } from "./websocket";

const BROWSER_PATH = "/devtools/browser/terminal-browser";

// The opt-in --remote-debugging-port: the same relay as the private socket, on
// 127.0.0.1, for CDP tools (Playwright, Puppeteer) that only speak TCP. The Host
// check keeps a web page on a rebinding domain from reaching it.
export function serveDebuggingPort(relay: CdpRelay, port: number, limits: CdpLimits): Promise<{ server: net.Server; port: number }> {
  let bound = port;
  const ourHost = (host: string | undefined) => host === `127.0.0.1:${bound}` || host === `localhost:${bound}`;
  const version = () =>
    JSON.stringify({
      Browser: `Chrome/${process.versions.chrome}`,
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: `ws://127.0.0.1:${bound}${BROWSER_PATH}`,
    });
  const server = net.createServer((connection) =>
    acceptWebSocket(connection, (socket) => relay.connect(socket), limits, {
      allow: (path, headers) => ourHost(headers.get("host")) && (!headers.has("upgrade") || path === BROWSER_PATH),
      answer: async (path) => (path === "/json/version" || path === "/json/version/" ? { status: "200 OK", body: version() } : null),
    }),
  );
  server.maxConnections = limits.maxConnections;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      bound = (server.address() as net.AddressInfo).port;
      resolve({ server, port: bound });
    });
  });
}

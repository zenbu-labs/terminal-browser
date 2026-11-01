// A fake terminal that can split, served on TERMINAL_BROWSER_TERMINAL_SOCKET.
// A split becomes another headless pane: a second pixel owner plus the same
// "open" request the CLI would send, so extension windows open as real panes.
// Like the CLI, it fetches the pane's URL and flags from the daemon with the launch token.
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { REPO } from "./tb.mjs";

const require = createRequire(import.meta.url);

export async function startFakeTerminal(socket) {
  const { OwnerServer } = require(path.join(REPO, "pixel/packages/pixel/dist/host/server.js"));
  let tb = null;
  const panes = [];
  const paneId = (tty) => `pane:${tty}`;
  let focused = null;

  function ask(message) {
    return new Promise((resolve, reject) => {
      const conn = net.connect(tb.daemonSock);
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        conn.end();
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
      });
      conn.on("error", reject);
      conn.write(JSON.stringify(message) + "\n");
    });
  }

  async function openPane(command) {
    const at = command.indexOf("open");
    if (at !== command.length - 1) throw new Error(`pane command carries arguments: ${JSON.stringify(command)}`);
    const pairs = command.slice(1, at).filter((part) => /^[A-Z_][A-Z0-9_]*=/.test(part));
    const env = Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
    const claimed = await ask({ cmd: "claim-launch", token: env.TERMINAL_BROWSER_LAUNCH });
    if (!claimed.ok) throw new Error(`launch claim failed: ${claimed.error}`);
    const n = panes.length + 2;
    const tty = `${tb.tty}p${n}`;
    const ownerSocket = path.join(tb.home, `owner${n}.sock`);
    const owner = new OwnerServer(ownerSocket, () => tb.cell);
    fs.writeFileSync(path.join(tb.env.XDG_STATE_HOME, "pixel", "instances", tty.replace(/[^\w-]/g, "_") + ".json"), JSON.stringify({
      tty, pid: process.pid, socket: ownerSocket, protocol: 1, name: "pane", title: "pane", cwd: tb.home, startedAt: Date.now(),
    }));
    const pane = { tty, owner, guest: null, conn: net.connect(tb.daemonSock) };
    focus(paneId(tty));
    owner.onJoin = (guest) => {
      pane.guest = guest;
      guest.onFrame = ({ ack }) => ack();
      guest.send({ type: "init", cols: 100, rows: 30, width: 1000, height: 600, cell: [tb.cell.width, tb.cell.height], colors: { foreground: [230, 230, 230, 255], background: [24, 24, 28, 255], palette: [] }, focused: focused === paneId(tty) });
    };
    pane.conn.on("error", () => {});
    pane.conn.write(JSON.stringify({ cmd: "open", tty, argv: claimed.argv, env: { ...process.env, ...tb.env, TERM: "xterm-kitty", TERMINAL_BROWSER_TERMINAL_SOCKET: socket, ...env }, cwd: tb.home }) + "\n");
    panes.push(pane);
  }

  function focus(id) {
    focused = id;
    tb.setFocused(id === paneId(tb.tty));
    for (const pane of panes) pane.guest?.send({ type: "focus", focused: id === paneId(pane.tty) });
  }

  const server = net.createServer((connection) => {
    let buffer = "";
    connection.on("data", async (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      let result = {};
      if (request.method === "hello") result = { name: "conformance", methods: ["getCurrentPane", "split", "focusPane"] };
      else if (request.method === "getCurrentPane") result = { pane: { id: paneId(request.params.tty), tab: "1" } };
      else if (request.method === "split") await openPane(request.params.command).catch((error) => console.error(`fake terminal: ${error.message}`));
      else if (request.method === "focusPane") focus(request.params.pane);
      connection.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
    connection.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  return {
    socket,
    attach(browser) {
      tb = browser;
    },
    async stop() {
      for (const pane of panes) {
        try { pane.conn.end(); pane.owner.stop(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(path.dirname(socket), { recursive: true, force: true });
    },
  };
}

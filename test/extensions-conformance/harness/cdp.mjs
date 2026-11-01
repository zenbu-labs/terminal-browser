// Browser-level CDP client with flattened auto-attach, logging every console
// message / exception / failed request from extension workers and pages.
export async function browserCdp(wsUrl, log, filter = (t) => t.url.startsWith("chrome-extension://"), wait = !process.env.NO_WAIT) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  const sessions = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const t0 = Date.now();
  const api = { send, close: () => ws.close(), sessions, onEvent: null };
  const out = (s) => log(`[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${s}`);
  ws.addEventListener("message", async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    api.onEvent?.(msg);
    const sid = msg.sessionId;
    const who = sid ? sessions.get(sid) : "browser";
    if (msg.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = msg.params;
      const interesting = filter(targetInfo);
      sessions.set(sessionId, `${targetInfo.type}:${targetInfo.url.replace(/^chrome-extension:\/\/[a-p]{32}/, "")}`);
      out(`attached ${targetInfo.type} ${targetInfo.url} waiting=${waitingForDebugger} interesting=${interesting}`);
      if (interesting) {
        await send("Runtime.enable", {}, sessionId);
        await send("Log.enable", {}, sessionId);
        await send("Network.enable", {}, sessionId);
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: wait, flatten: true }, sessionId);
      }
      if (waitingForDebugger) await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const a = msg.params.args.map((x) => x.value ?? x.description ?? x.type).join(" ");
      const f = msg.params.stackTrace?.callFrames?.[0];
      out(`${who} console.${msg.params.type}: ${a.slice(0, 6000)}${f ? ` @${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}` : ""}`);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      out(`${who} EXCEPTION: ${(d.exception?.description ?? d.text).slice(0, 600)} @${d.url}:${d.lineNumber + 1}`);
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      out(`${who} log.${e.level} [${e.source}]: ${e.text.slice(0, 400)} ${e.url ?? ""}`);
    } else if (msg.method === "Network.requestWillBeSent") {
      if (!/^data:/.test(msg.params.request.url)) out(`${who} net-> ${msg.params.request.method} ${msg.params.request.url.slice(0, 160)}`);
    } else if (msg.method === "Network.responseReceived") {
      const r = msg.params.response;
      out(`${who} net<- ${r.status} ${r.mimeType} ${r.url.slice(0, 160)}`);
    } else if (msg.method === "Network.loadingFailed") {
      out(`${who} net FAIL ${msg.params.errorText} ${msg.params.blockedReason ?? ""}`);
    } else if (msg.method === "Target.detachedFromTarget") {
      out(`detached ${sessions.get(msg.params.sessionId)}`);
    }
  });
  await send("Target.setDiscoverTargets", { discover: true });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: wait, flatten: true });
  const attachExisting = async () => {
    const { result } = await send("Target.getTargets");
    for (const t of result.targetInfos) if (filter(t) && !t.attached) await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  };
  await attachExisting();
  return api;
}

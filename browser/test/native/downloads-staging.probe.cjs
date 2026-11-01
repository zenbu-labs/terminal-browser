// The downloads manager only writes files for downloads it places itself, and only inside the downloads folder:
// a download whose path a DevTools client (Browser.setDownloadBehavior) or another will-download handler chose
// leaves nothing in the downloads folder, and our own staging files are gone after every outcome, including a crash.
// Nothing downloaded here is ever opened: shell.openPath and showItemInFolder are replaced by recorders.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, session, shell } = require("electron");

const profile = process.env.PROBE_PROFILE;
for (const variable of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
  process.env[variable] = path.join(profile, variable.toLowerCase());
}
const downloadsDir = path.join(profile, "Downloads");
const agentDir = path.join(profile, "agent-files");
const otherDir = path.join(profile, "elsewhere");
for (const dir of [downloadsDir, agentDir, otherDir]) fs.mkdirSync(dir, { recursive: true });
app.setPath("downloads", downloadsDir);
app.setName("terminal-browser");
shell.openPath = async () => "";
shell.showItemInFolder = () => {};

const crashNote = path.join(profile, "crashed-staging.json");
const PAYLOAD = "harmless bytes\n";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

require("./harness.cjs").run("downloads-staging", async ({ eq: expectEqual, check: expect, sleep, phase }) => {
  let failed = false;
  const check = (ok, message) => (expect(ok, message) || ((failed = true), false));
  const eq = (actual, expected, message) => (expectEqual(actual, expected, message) || ((failed = true), false));
  const streams = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const name = path.basename(url.pathname);
    const headers = { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` };
    if (url.searchParams.has("slow")) {
      res.writeHead(200, { ...headers, "Content-Length": String(1 << 20) });
      res.write(Buffer.alloc(4096, 120));
      streams.push(res);
      return;
    }
    if (url.pathname === "/page") return res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>page</title>");
    res.writeHead(200, headers).end(PAYLOAD);
  });
  const site = `http://127.0.0.1:${server.address().port}`;
  const { startBrowsing } = require("../../dist/browsing/index.js");

  if (phase === 2) {
    const staged = JSON.parse(fs.readFileSync(crashNote, "utf8"));
    check(fs.existsSync(staged.file), `the crashed run left its staging file ${staged.file} for this run to clean up`);
    const { downloads } = startBrowsing();
    eq(fs.existsSync(staged.file), false, "startup removes a staging file a crashed run left behind");
    eq(fs.readdirSync(downloadsDir), [], "nothing else is left in the downloads folder after the crash");
    const record = downloads.get(staged.id);
    eq([record?.state, record?.error], ["interrupted", "CRASH"], "the crashed download is interrupted");
    server.close();
    return;
  }

  const { downloads } = startBrowsing();
  const leftovers = () => fs.readdirSync(downloadsDir);
  const window = new BrowserWindow({ show: false });
  await window.loadURL(`${site}/page`);
  const created = () =>
    new Promise((resolve) => {
      const stop = downloads.created.add((record) => {
        stop();
        resolve(record.id);
      });
    });
  const settled = async (id) => {
    for (let i = 0; i < 300; i++) {
      const record = downloads.get(id);
      if (record && record.state !== "in_progress") return record;
      await sleep(50);
    }
    throw new Error(`download ${id} never settled`);
  };
  const click = (href, gesture = true) =>
    window.webContents.executeJavaScript(
      `(() => { const a = document.createElement("a"); a.href = ${JSON.stringify(href)}; a.download = ""; document.body.append(a); a.click(); a.remove(); })()`,
      gesture,
    );

  // An agent's download over CDP, the way agent-browser asks for it.
  const cdp = window.webContents.debugger;
  cdp.attach("1.3");
  const progress = new Map();
  cdp.on("message", (_event, method, params) => {
    if (method === "Browser.downloadProgress") progress.set(params.guid, params.state);
  });
  await cdp.sendCommand("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: agentDir, eventsEnabled: true });
  // A file type that can run code, without a click: our manager would hold it for the user, but it isn't ours.
  for (const [name, gesture] of [["agent.bin", true], ["agent.command", false]]) {
    progress.clear();
    const createdId = created();
    await click(`${site}/${name}`, gesture);
    const agentId = await createdId;
    const agentRecord = await settled(agentId).catch(() => downloads.get(agentId));
    for (let i = 0; i < 100 && ![...progress.values()].includes("completed"); i++) await sleep(50);
    const [guid] = [...progress.keys()];
    eq(fs.readFileSync(path.join(agentDir, guid ?? "missing"), "utf8"), PAYLOAD, `the CDP download ${name} lands where the DevTools client asked`);
    await sleep(500);
    eq(leftovers(), [], `the CDP download ${name} leaves nothing in the downloads folder`);
    eq([agentRecord.state, agentRecord.danger], ["complete", "safe"], `the CDP download ${name} still completes in the list`);
    check(!agentRecord.filename?.startsWith(downloadsDir), `the CDP download ${name}'s record doesn't claim a file in the downloads folder (${agentRecord.filename})`);
    for (const file of leftovers()) fs.rmSync(path.join(downloadsDir, file));
  }
  await cdp.sendCommand("Browser.setDownloadBehavior", { behavior: "default" });
  cdp.detach();

  // Another will-download handler chose the path, before ours runs and after it.
  const elsewhere = (name) => path.join(otherDir, name);
  const before = (_event, item) => {
    if (item.getFilename() === "before.bin") item.setSavePath(elsewhere("before.bin"));
  };
  const after = (_event, item) => {
    if (item.getFilename() === "after.bin") item.setSavePath(elsewhere("after.bin"));
  };
  session.defaultSession.prependListener("will-download", before);
  session.defaultSession.on("will-download", after);
  for (const name of ["before.bin", "after.bin"]) {
    const id = created();
    await click(`${site}/${name}`);
    const record = await settled(await id);
    eq([record.state, record.filename], ["complete", elsewhere(name)], `a path chosen by another handler (${name}) is tracked where it really is`);
    eq(fs.readFileSync(elsewhere(name), "utf8"), PAYLOAD, `${name} has its bytes`);
    eq(leftovers(), [], `${name} leaves nothing in the downloads folder`);
  }
  session.defaultSession.off("will-download", before);
  session.defaultSession.off("will-download", after);

  // Our own downloads: completed, cancelled, and erased while interrupted.
  const ownId = created();
  await click(`${site}/own.bin`);
  const own = await settled(await ownId);
  eq([own.state, own.filename], ["complete", path.join(downloadsDir, "own.bin")], "our own download gets its name");
  eq(leftovers(), ["own.bin"], "only the finished file is left");
  fs.rmSync(own.filename);

  const startSlow = async (name) => {
    const id = created();
    await click(`${site}/${name}?slow`);
    const recordId = await id;
    for (let i = 0; i < 100 && !leftovers().some((file) => file.endsWith(".crdownload")); i++) await sleep(50);
    return recordId;
  };
  const cancelled = await startSlow("cancel.bin");
  check(leftovers().length === 1, `an unfinished download is staged in the downloads folder (${leftovers()})`);
  downloads.cancel(cancelled);
  await settled(cancelled);
  await sleep(300);
  eq(leftovers(), [], "cancelling removes the staging file");

  const interrupted = await startSlow("interrupt.bin");
  streams.pop().destroy();
  for (let i = 0; i < 100 && downloads.get(interrupted)?.state === "in_progress"; i++) await sleep(50);
  downloads.erase(interrupted);
  await sleep(500);
  eq(leftovers(), [], "erasing an interrupted download removes its staging file");

  // A crash in the middle of a download; the next run cleans up.
  if (failed) return;
  const crashed = await startSlow("crash.bin");
  const [staging] = leftovers();
  fs.writeFileSync(crashNote, JSON.stringify({ id: crashed, file: path.join(downloadsDir, staging) }));
  fs.writeSync(1, "PROBE NEXT downloads-staging\n");
  process.kill(process.pid, "SIGKILL");
});

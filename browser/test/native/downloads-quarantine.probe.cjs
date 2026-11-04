// Every download is quarantined like Chrome's (com.apple.quarantine before the file gets its name), and a type
// that can run code is held unconfirmed until the user keeps it, for page and chrome.downloads downloads alike.
// Nothing downloaded here is ever opened: shell.openPath is replaced by a recorder.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { app, BrowserWindow, shell } = require("electron");

const profile = process.env.PROBE_PROFILE;
for (const variable of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
  process.env[variable] = path.join(profile, variable.toLowerCase());
}
const downloadsDir = path.join(profile, "Downloads");
fs.mkdirSync(downloadsDir, { recursive: true });
app.setPath("downloads", downloadsDir);
app.setName("terminal-browser");

const opened = [];
shell.openPath = async (file) => {
  opened.push(file);
  return "";
};
shell.showItemInFolder = () => {};

const PAYLOAD = "echo harmless\n";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

function quarantineFlag(file) {
  try {
    return execFileSync("xattr", ["-p", "com.apple.quarantine", file], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function whereFrom(file) {
  try {
    return execFileSync("xattr", ["-p", "com.apple.metadata:kMDItemWhereFroms", file]).toString("latin1");
  } catch {
    return "";
  }
}

require("./harness.cjs").run("downloads-quarantine", async ({ eq, check, sleep }) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/page.html") {
      const links = ["Report.terminal", "run.command", "App.app.zip"].map((name) => `<a id="${name}" href="/${name}" download>${name}</a>`);
      return res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>downloads</title>${links.join(" ")}`);
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${path.basename(url.pathname)}"` }).end(PAYLOAD);
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const site = `http://127.0.0.1:${port}`;

  const { startBrowsing } = require("../../dist/browsing/index.js");
  const { downloads } = startBrowsing();
  const handlers = new Map();
  const prompts = [];
  let promptAnswer = false;
  const service = {
    loaded: new Map(),
    router: { handle: (name, run) => handlers.set(name, run) },
    events: { hasListener: () => false, listenerRemoved: { add() {} } },
    broadcast() {},
    dispatch() {},
    get: () => null,
    currentWindow: () => ({
      host: {
        prompt: async (request) => {
          prompts.push(request);
          return promptAnswer;
        },
      },
    }),
  };
  require("../../dist/extensions/api/downloads.js").installDownloads(service);
  const { watchInput } = require("../../dist/extensions/user-activation.js");
  const extension = {
    id: EXTENSION_ID,
    name: "probe",
    path: "/nonexistent",
    manifest: { manifest_version: 3, name: "probe", version: "1" },
    allowsFileAccess: false,
    record: { installedAt: 1 },
    hasApiPermission: (permission) => ["downloads", "downloads.open"].includes(permission),
    hadRecentUserGesture: () => false,
  };
  const popup = new EventEmitter();
  watchInput(popup);
  const clickInPopup = () => {
    popup.emit("input-event", {}, { type: "mouseDown" });
    const frame = { isDestroyed: () => false, detached: false, documentLifecycle: "active", hasTransientUserActivation: () => true };
    return { kind: "frame", extension, contents: popup, frame };
  };
  const call = (name, caller, ...args) => Promise.resolve(handlers.get(name)(caller, ...args));
  const search = async (id) => (await call("downloads.search", clickInPopup(), { id }))[0];

  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 300; i++) {
      const value = predicate();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const unconfirmed = () => fs.readdirSync(downloadsDir).filter((name) => name.endsWith(".crdownload"));
  const settledRecord = (id) =>
    waitFor(() => {
      const record = downloads.get(id);
      if (!record) return null;
      if (record.state !== "in_progress") return record;
      if (record.danger !== "file") return null;
      const [held] = unconfirmed();
      return held && quarantineFlag(path.join(downloadsDir, held)) ? record : null;
    }, `download ${id}`);
  const quarantinedLikeChrome = (file, label) =>
    check(/^[0-9a-f]{4};[0-9a-f]{8};terminal-browser;[0-9A-F-]{36}$/.test(quarantineFlag(file) ?? ""), `${label}: quarantine flag ${quarantineFlag(file)}`);

  const pageDownload = async (window, name, gesture) => {
    const created = new Promise((resolve) => {
      const stop = downloads.created.add((record) => {
        stop();
        resolve(record.id);
      });
    });
    await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(name)}).click()`, gesture);
    return settledRecord(await created);
  };

  // A page's own downloads, started without and with a click.
  const window = new BrowserWindow({ show: false });
  await window.loadURL(`${site}/page.html`);
  const terminal = await pageDownload(window, "Report.terminal", false);
  eq([terminal.state, terminal.danger], ["complete", "safe"], "page .terminal (Chrome has no rule for it, quarantine guards it)");
  quarantinedLikeChrome(terminal.filename, "page .terminal");
  check(whereFrom(terminal.filename).includes(`${site}/Report.terminal`) && whereFrom(terminal.filename).includes(`${site}/page.html`), "page .terminal where-from lists the file and the page");
  const zip = await pageDownload(window, "App.app.zip", false);
  eq([zip.state, zip.danger], ["complete", "safe"], "page .app.zip");
  quarantinedLikeChrome(zip.filename, "page .app.zip");

  const command = await pageDownload(window, "run.command", false);
  eq([command.state, command.danger], ["in_progress", "file"], "page .command without a gesture is held as dangerous");
  eq(fs.existsSync(command.filename), false, "nothing carries the .command name while held");
  eq((await search(command.id)).danger, "file", "chrome.downloads reports the page's .command as dangerous");
  downloads.discard(command.id);
  eq([downloads.get(command.id), unconfirmed()], [null, []], "discarding a held download deletes it");

  const clicked = await pageDownload(window, "run.command", true);
  eq([clicked.state, clicked.danger], ["in_progress", "file"], "a click on a site never visited before still holds a .command");
  downloads.accept(clicked.id);
  const kept = downloads.get(clicked.id);
  eq([kept.state, kept.danger], ["complete", "accepted"], "keeping a held download completes it");
  eq(fs.readFileSync(kept.filename, "utf8"), PAYLOAD, "kept bytes land under the chosen name");
  quarantinedLikeChrome(kept.filename, "kept .command");
  window.destroy();

  // The same files through chrome.downloads, the R3-2 path.
  const extensionDownload = async (options) => settledRecord(await call("downloads.download", clickInPopup(), options));
  const viaApi = {};
  for (const name of ["Report.terminal", "run.command", "App.app.zip"]) {
    viaApi[name] = await extensionDownload({ url: `${site}/${name}`, filename: `ext-${name}` });
  }
  eq([viaApi["Report.terminal"].state, viaApi["Report.terminal"].danger], ["complete", "safe"], "chrome.downloads .terminal");
  quarantinedLikeChrome(viaApi["Report.terminal"].filename, "chrome.downloads .terminal");
  eq([viaApi["App.app.zip"].state, viaApi["App.app.zip"].danger], ["complete", "safe"], "chrome.downloads .app.zip");
  quarantinedLikeChrome(viaApi["App.app.zip"].filename, "chrome.downloads .app.zip");
  eq([viaApi["run.command"].state, viaApi["run.command"].danger], ["in_progress", "file"], "chrome.downloads .command is dangerous like Chrome");
  await call("downloads.open", clickInPopup(), viaApi["run.command"].id).then(
    () => check(false, "opening a held download succeeded"),
    (error) => eq(error.message, "Download must be complete", "a held download can't be opened"),
  );

  promptAnswer = true;
  await call("downloads.acceptDanger", clickInPopup(), viaApi["run.command"].id);
  eq(prompts.length, 1, "acceptDanger asks the user");
  const accepted = await search(viaApi["run.command"].id);
  eq([accepted.state, accepted.danger], ["complete", "accepted"], "acceptDanger keeps the file once the user agrees");
  quarantinedLikeChrome(accepted.filename, "accepted .command");

  promptAnswer = false;
  await call("downloads.open", clickInPopup(), accepted.id).then(
    () => check(false, "open went through without the user"),
    (error) => eq(error.message, 'The "downloads.open" permission is required', "open of a .command right after a click still asks"),
  );
  eq(prompts.length, 2, "the open prompt was shown");
  await call("downloads.open", clickInPopup(), viaApi["Report.terminal"].id);
  eq(prompts.length, 2, "a quarantined .terminal opens right after a click like Chrome, macOS checks it");

  // The PoC's data: URL and POST variants.
  const dataTerminal = await extensionDownload({ url: `data:application/octet-stream;base64,${Buffer.from(PAYLOAD).toString("base64")}`, filename: "data-Report.terminal" });
  eq(dataTerminal.state, "complete", "data: .terminal completes");
  quarantinedLikeChrome(dataTerminal.filename, "data: .terminal");
  check(whereFrom(dataTerminal.filename).includes(`chrome-extension://${EXTENSION_ID}/`), "a data: download is attributed to the extension");
  const posted = await extensionDownload({ url: `${site}/post.command`, method: "POST", body: "x=1", filename: "post.command" });
  eq([posted.state, posted.danger], ["in_progress", "file"], "a POST .command is held too");
  check(!!quarantineFlag(path.join(downloadsDir, unconfirmed()[0])), "the held POST bytes are already quarantined");
  downloads.discard(posted.id);

  eq(opened, [viaApi["Report.terminal"].filename], "only the confirmed .terminal reached shell.openPath (stubbed)");
  server.close();
});

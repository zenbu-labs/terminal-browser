#!/usr/bin/env node
// An unpacked extension loaded with `terminal-browser extensions load` into a running browser answers HTTP
// sign-in challenges through webRequest.onAuthRequired before any sign-in dialog shows, and a challenge it
// leaves alone still gets the dialog.
//   node test/extension-sign-in/run.mjs [--electron <bin>]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

import { REPO, SCRATCH, sleep, startBrowser } from "../extensions-conformance/harness/tb.mjs";

const { values: opts } = parseArgs({ options: { electron: { type: "string" } } });

const seen = [];
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/ready" || pathname === "/challenged") {
    seen.push({ path: pathname, url: new URL(req.url, "http://localhost").searchParams.get("url") });
    return res.writeHead(200, { "access-control-allow-origin": "*" }).end();
  }
  const realm = pathname.match(/^\/(answered|ignored)\//)?.[1];
  if (!realm) return res.writeHead(200, { "content-type": "text/html" }).end("<title>start</title>");
  const given = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
  const user = given ? Buffer.from(given, "base64").toString() : null;
  seen.push({ path: pathname, user });
  if (!user) {
    return res.writeHead(401, { "www-authenticate": `Basic realm="${realm}"`, "content-type": "text/html" }).end("<title>denied</title>");
  }
  res.writeHead(200, { "content-type": "text/html" }).end(`<title>signed in as ${user}</title>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}`;

const home = fs.mkdtempSync(path.join(SCRATCH, "tbsi-"));
const extension = path.join(home, "answerer");
fs.mkdirSync(extension);
fs.writeFileSync(
  path.join(extension, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Sign-in answerer",
    version: "1",
    permissions: ["webRequest", "webRequestAuthProvider"],
    host_permissions: ["http://127.0.0.1/*"],
    background: { service_worker: "worker.js" },
  }),
);
fs.writeFileSync(
  path.join(extension, "worker.js"),
  `chrome.webRequest.onAuthRequired.addListener((details, callback) => {
    fetch("${site}/challenged?url=" + encodeURIComponent(new URL(details.url).pathname));
    if (details.realm === "answered") callback({ authCredentials: { username: "extension", password: "pw" } });
    else callback({});
  }, { urls: ["http://127.0.0.1/*"] }, ["asyncBlocking"]);
  fetch("${site}/ready");`,
);

const tb = await startBrowser({ electron: opts.electron, home, out: path.join(home, "browser"), label: "sign-in", url: `${site}/` });
const isPage = (t) => t.type === "page" && t.url.startsWith(site);
const title = async () => (await tb.targets()).find(isPage)?.title;
async function until(what, condition, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let failed = false;
try {
  await tb.waitTarget(isPage);
  await tb.mainEval(`
    const { AuthPrompts } = req(dist + "/session/auth.js");
    const ask = AuthPrompts.prototype.ask;
    globalThis.signInDialogs = [];
    AuthPrompts.prototype.ask = function (tabId, pending, fallback) {
      globalThis.signInDialogs.push(pending.kind);
      return ask.call(this, tabId, pending, fallback);
    };
  `);
  const dialogs = () => tb.mainEval("return globalThis.signInDialogs");

  const loaded = spawnSync(process.execPath, ["--no-warnings", path.join(REPO, "cli/dist/main.js"), "extensions", "load", extension], {
    env: { ...process.env, ...tb.env },
    encoding: "utf8",
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /^loaded Sign-in answerer 1 /);
  await until("the extension's service worker", () => seen.some((entry) => entry.path === "/ready"));

  await tb.evalIn(isPage, `location.href = "/answered/page"; 1`);
  await until("the extension's answer", async () => (await title()) === "signed in as extension:pw");
  assert.deepEqual(await dialogs(), [], "a sign-in dialog showed for a challenge the extension answered");
  assert.deepEqual(
    seen.filter((entry) => entry.path === "/answered/page").map((entry) => entry.user),
    [null, "extension:pw"],
  );

  await tb.evalIn(isPage, `location.href = "/ignored/page"; 1`);
  await until("the sign-in dialog", async () => (await dialogs()).length > 0);
  assert.deepEqual(await dialogs(), ["login"]);
  assert.deepEqual(
    seen.filter((entry) => entry.path === "/challenged").map((entry) => entry.url),
    ["/answered/page", "/ignored/page"],
    "the extension saw both challenges",
  );
  // The dialog ignores keys for a moment after it shows, so a keypress meant for the page can't answer it.
  await sleep(1000);
  await tb.type("rob");
  await tb.key("tab");
  await tb.type("typed");
  await tb.key("enter");
  await until("the typed sign-in", async () => (await title()) === "signed in as rob:typed");
  // fixme: placeholder copy
  console.log("PASS extension answers sign-in before the dialog; an ignored challenge shows the dialog");
} catch (error) {
  failed = true;
  // fixme: placeholder copy
  console.log(`FAIL ${error.message}`);
  console.log(`  requests: ${JSON.stringify(seen)}`);
  console.log(`  dialogs: ${JSON.stringify(await tb.mainEval("return globalThis.signInDialogs").catch(() => null))}`);
  await tb.shot("failure", 0).then((file) => file && console.log(`  frame: ${file}`));
} finally {
  await tb.stop();
  server.closeAllConnections();
  server.close();
  if (!failed) fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

// Shared setup for the native probes: each probe is an Electron main script that run.mjs launches with the
// patched Electron, an isolated profile, and a local HTTP server extensions and pages report results to.
const { app, session } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

app.setPath("userData", process.env.PROBE_PROFILE);
app.dock?.hide();
app.on("window-all-closed", () => {});

const phase = Number(process.env.PROBE_PHASE ?? 1);
const reports = new Map();
const waiters = new Map();
const failures = [];

function report(key, value) {
  reports.set(key, value);
  for (const resolve of waiters.get(key) ?? []) resolve(value);
  waiters.delete(key);
}

function waitReport(key, ms = 15000) {
  if (reports.has(key)) return Promise.resolve(reports.get(key));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no report "${key}" within ${ms}ms`)), ms);
    const list = waiters.get(key) ?? [];
    list.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
    waiters.set(key, list);
  });
}

const routes = {
  "/page": () => [200, "text/html", "<!doctype html><title>probe</title>"],
  "/auth": (req) =>
    req.headers.authorization === `Basic ${Buffer.from("probe:pw").toString("base64")}`
      ? [200, "text/plain", "authorized"]
      : [401, "text/plain", "unauthorized", { "WWW-Authenticate": 'Basic realm="probe"' }],
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/report") {
      report(url.searchParams.get("key"), JSON.parse(url.searchParams.get("value")));
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("ok");
      return;
    }
    const [status, type, body, headers] = (routes[url.pathname] ?? (() => [200, "text/plain", "ok"]))(req);
    res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*", ...headers }).end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// Writes an extension into the profile. `report.js` gives its scripts report(key, value) back to this server.
function writeExtension(name, port, files) {
  const dir = path.join(process.env.PROBE_PROFILE, "extensions", name);
  fs.mkdirSync(dir, { recursive: true });
  const all = {
    "report.js": `self.report = (key, value) => fetch("http://127.0.0.1:${port}/report?key=" + encodeURIComponent(key) + "&value=" + encodeURIComponent(JSON.stringify(value ?? null)));`,
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    fs.writeFileSync(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content, null, 1));
  }
  return dir;
}

function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}

function eq(actual, expected, message) {
  return check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(name, body) {
  app.whenReady().then(async () => {
    let next = false;
    try {
      const port = await startServer();
      next = (await body({ ses: session.defaultSession, port, phase, waitReport, writeExtension, check, eq, sleep })) === "next";
    } catch (error) {
      failures.push(error.stack ?? String(error));
    }
    if (failures.length) console.log(`PROBE FAIL ${name}\n  ${failures.join("\n  ")}`);
    else console.log(next ? `PROBE NEXT ${name}` : `PROBE PASS ${name}`);
    if (next && !failures.length) app.quit();
    else app.exit(failures.length ? 1 : 0);
  });
}

module.exports = { run };

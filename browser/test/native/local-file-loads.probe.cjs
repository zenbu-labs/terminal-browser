// No frame shows a file:// document, since one could read every other local file (with Electron's
// GrantFileProtocolExtraPrivileges fuse on, any other file's contents): file:// page loads become sandboxed local
// documents, folders and PDFs still show, and redirects can't lead into local documents or our pages.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { BrowserWindow, session } = require("electron");

const pixelDir = path.dirname(require.resolve("@zenbu-labs/pixel/package.json", { paths: [path.join(__dirname, "../..")] }));
const { configureBrowserSession } = require(path.join(pixelDir, "dist/web/browser-session.js"));
const scheme = require("../../dist/pages/scheme.js");
const { guardInternalNavigation } = require("../../dist/pages/navigation.js");

scheme.registerScheme();

const doc = (file) => `terminal-browser-file://file${file.split("/").map(encodeURIComponent).join("/")}`;

function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url, "http://127.0.0.1").pathname];
    if (!route) return res.writeHead(404).end();
    res.writeHead(...route).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function pdf(text) {
  const content = `BT /F1 24 Tf 20 60 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function settle(contents, ms = 400) {
  for (let i = 0; i < 100 && contents.isLoading(); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, ms));
}

require("./harness.cjs").run("local-file-loads", async ({ ses, port, waitReport, eq, check }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PROBE_PROFILE, "files-")));
  const downloads = path.join(root, "Downloads");
  const ssh = path.join(root, ".ssh");
  fs.mkdirSync(downloads);
  fs.mkdirSync(ssh);
  const secret = path.join(ssh, "id_ed25519");
  fs.writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY----- probe-secret");
  const report = (key, expr) => `fetch("http://127.0.0.1:${port}/report?key=${key}&value=" + encodeURIComponent(JSON.stringify(${expr})))`;
  const read = (frame) => `(() => { try { return ${frame}.contentDocument?.body?.innerText ?? "no document"; } catch (error) { return "blocked: " + error.name; } })()`;
  const invoice = path.join(downloads, "invoice.html");
  fs.writeFileSync(
    invoice,
    `<!doctype html><title>invoice</title><iframe id=f src="file://${secret}"></iframe><iframe id=g src="../.ssh/id_ed25519"></iframe>
<script>setTimeout(() => ${report("invoice", `{ origin: String(origin), file: ${read("f")}, relative: ${read("g")} }`)}, 600);</script>`,
  );
  fs.writeFileSync(path.join(downloads, "page.html"), "<!doctype html><title>page</title>");
  fs.writeFileSync(path.join(downloads, "build.log"), "line one\nline two\n");
  fs.writeFileSync(path.join(downloads, "paper.pdf"), pdf("probe pdf"));
  fs.writeFileSync(
    path.join(root, "reader.html"),
    `<!doctype html><iframe id=f src="Downloads/build.log"></iframe><script>f.onload = () => ${report("raw", read("f"))};</script>`,
  );

  // Electron's fuses, as a release has them: in a session with none of our handling, a file:// page can't read another file.
  const raw = session.fromPartition("raw-file-pages");
  const rawWindow = new BrowserWindow({ show: false, webPreferences: { session: raw } });
  await rawWindow.loadURL(`file://${path.join(root, "reader.html")}`);
  const rawRead = await waitReport("raw");
  check(typeof rawRead === "string" && !rawRead.includes("line one"), `a file:// page read another local file (the GrantFileProtocolExtraPrivileges fuse is on): ${rawRead}`);
  rawWindow.destroy();

  configureBrowserSession(ses);
  scheme.servePages(() => ({ cwd: root, theme: null }));
  guardInternalNavigation();
  ses.on("will-download", (_event, item) => item.setSavePath(path.join(root, "saved", item.getFilename())));

  const tab = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  const contents = tab.webContents;

  // The R5-M1 page: a downloaded html file opened from a bookmark, as the browser, through its file:// url.
  await contents.loadURL(`file://${invoice}`).catch(() => {});
  eq(contents.getURL(), doc(invoice), "a file:// page load shows the sandboxed local document instead");
  const stolen = await waitReport("invoice");
  eq(stolen.origin, "null", "the local document runs with an opaque origin");
  check(!JSON.stringify(stolen).includes("probe-secret"), `the local document read a file outside its folder: ${JSON.stringify(stolen)}`);

  await contents.loadURL(`file://${downloads}/`).catch(() => {});
  await settle(contents);
  eq(contents.getURL(), `${doc(downloads)}/`, "a folder opens as a local document");
  eq(contents.getTitle(), `Index of ${downloads}`, "its listing");
  await contents.executeJavaScript(`document.querySelector('a[href$="/page.html"]').click()`);
  await settle(contents);
  eq([contents.getURL(), contents.getTitle()], [doc(path.join(downloads, "page.html")), "page"], "a file in the listing opens as a local document");

  await contents.loadURL(doc(path.join(downloads, "build.log"))).catch(() => {});
  eq(await contents.executeJavaScript("[document.contentType, document.body.innerText.trim()]"), ["text/plain", "line one\nline two"], "a log file shows as text");

  await contents.loadURL(`file://${path.join(downloads, "paper.pdf")}`).catch(() => {});
  await settle(contents, 1500);
  const frames = contents.mainFrame.framesInSubtree.map((frame) => frame.url);
  eq(contents.getURL(), doc(path.join(downloads, "paper.pdf")), "a PDF opens as a local document");
  check(frames.some((url) => url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")), `the PDF viewer shows it: ${JSON.stringify(frames)}`);

  // R5-L1: a site the browser loaded (typed, a bookmark, the CLI) redirects into a local document or our pages.
  const site = await serve({
    "/to-doc": [302, { location: doc(secret) }],
    "/to-internal": [302, { location: "terminal-browser://settings/" }],
    "/to-file": [302, { location: `file://${secret}` }],
  });
  for (const route of ["/to-doc", "/to-internal", "/to-file"]) {
    await contents.loadURL("about:blank");
    await contents.loadURL(`http://127.0.0.1:${site}${route}`).catch(() => {});
    await settle(contents);
    const shown = await contents.executeJavaScript("document.body?.innerText ?? ''").catch(() => "");
    check(!/^terminal-browser|^file:/.test(contents.getURL()), `${route} redirected the tab to ${contents.getURL()}`);
    check(!shown.includes("probe-secret"), `${route} showed the file`);
  }

  const downloaded = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no download"), 3000);
    ses.once("will-download", (_event, item) =>
      item.once("done", (_done, state) => {
        clearTimeout(timer);
        resolve(state === "completed" ? fs.readFileSync(item.getSavePath(), "utf8") : state);
      }),
    );
    ses.downloadURL(`http://127.0.0.1:${site}/to-doc`);
  });
  check(!String(downloaded).includes("probe-secret"), `a download redirected into a local document saved the file: ${downloaded}`);
  const saved = path.join(root, "saved");
  const leaked = fs.existsSync(saved) ? fs.readdirSync(saved).filter((name) => fs.readFileSync(path.join(saved, name), "utf8").includes("probe-secret")) : [];
  eq(leaked, [], "no redirect saved the file as a download");
  tab.destroy();
});

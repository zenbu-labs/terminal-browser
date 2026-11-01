import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const SITE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../site");
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".js": "text/javascript", ".txt": "text/plain", ".json": "application/json" };

export function startServer(port = 0) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    hits.push({ path: url.pathname, method: req.method, headers: req.headers, at: Date.now() });
    if (url.pathname === "/download.txt") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="god-download.txt"' });
      return res.end("god download body\n");
    }
    if (url.pathname === "/slow-download.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(4 * 1024 * 1024), "content-disposition": 'attachment; filename="god-slow.bin"' });
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed || sent >= 4 * 1024 * 1024) return clearInterval(timer), res.end();
        res.write(Buffer.alloc(64 * 1024, 1));
        sent += 64 * 1024;
      }, 100);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (url.pathname === "/set-cookie") {
      res.writeHead(200, { "set-cookie": "served=1; Path=/", "content-type": "text/plain" });
      return res.end("cookie set");
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/page.html?redirected=1" });
      return res.end();
    }
    if (url.pathname === "/echo-headers") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify(req.headers));
    }
    if (url.pathname.startsWith("/dnr-") || url.pathname === "/blocked-by-webrequest") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end("reached " + url.pathname);
    }
    if (url.pathname === "/basic-auth") {
      const expected = "Basic " + Buffer.from("god:pw").toString("base64");
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="god"', "content-type": "text/plain" });
        return res.end("unauthorized");
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("authorized god");
    }
    if (url.pathname === "/auth-redirect") {
      res.writeHead(302, { location: `${url.searchParams.get("to")}?code=42` });
      return res.end();
    }
    if (url.pathname === "/auth-callback") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<title>auth</title>auth page");
    }
    if (url.pathname === "/history-push.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<title>push</title><script>setTimeout(()=>{history.pushState({},'', '/history-pushed'); location.hash='frag';}, 300)</script>");
    }
    if (url.pathname === "/frames.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<title>frames</title><iframe src="/page.html?frame=1"></iframe>');
    }
    const file = path.join(SITE, url.pathname === "/" ? "page.html" : url.pathname);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  const v6 = http.createServer((req, res) => server.emit("request", req, res));
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    const bound = server.address().port;
    v6.listen(bound, "::1", () => resolve({
      port: bound,
      hits,
      close: () => Promise.all([server, v6].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))),
    }));
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startServer(Number(process.argv[2] ?? 0));
  console.log(`http://localhost:${s.port}/`);
}

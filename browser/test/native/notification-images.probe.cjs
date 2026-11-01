// notifications.create loads http(s) images like Chrome's image_util.js does from the extension's context: no user
// cookies, and another site's image only with host access or that site's CORS consent; bounded in size and time.
const http = require("node:http");
const zlib = require("node:zlib");
const { Notification } = require("electron");

Notification.isSupported = () => false;

function png() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

require("./harness.cjs").run("notification-images", async ({ ses, eq, check }) => {
  const cookies = [];
  const image = png();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    cookies.push(req.headers.cookie ?? null);
    if (url.pathname === "/redirect") return res.writeHead(302, { Location: url.searchParams.get("to") }).end();
    if (url.pathname === "/slow") return setTimeout(() => res.writeHead(200, { "Content-Type": "image/png" }).end(image), 3000);
    if (url.pathname === "/big") return res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.alloc(9 * 1024 * 1024));
    const headers = { "Content-Type": "image/png" };
    if (url.pathname === "/cors.png") headers["Access-Control-Allow-Origin"] = "*";
    res.writeHead(200, headers).end(image);
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const permitted = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  for (const url of [permitted, other]) await ses.cookies.set({ url, name: "sid", value: "user-session" });

  const handlers = new Map();
  const service = {
    session: ses,
    router: { handle: (name, run) => handlers.set(name, run) },
    dispatch() {},
    onUnload() {},
    lastFocusedWindow: () => ({ host: { toast() {} } }),
  };
  require("../../dist/extensions/api/notifications.js").installNotifications(service);
  const limits = require("../../dist/extensions/api/notification-images.js").IMAGE_LIMITS;
  limits.timeoutMs = 1000;

  const extension = {
    id: "abcdefghijklmnopabcdefghijklmnop",
    name: "probe",
    path: "/nonexistent",
    baseUrl: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
    hasHostAccess: (url) => url.startsWith(`${permitted}/`),
  };
  const create = (iconUrl) =>
    Promise.resolve(handlers.get("notifications.create")({ extension }, { type: "basic", title: "t", message: "m", iconUrl })).then(
      () => "shown",
      (error) => error.message,
    );
  const failed = "Unable to download all specified images.";

  eq(await create(`${other}/plain.png`), failed, "another site's image without host access or CORS");
  eq(await create(`${other}/cors.png`), "shown", "another site's image that allows CORS");
  eq(await create(`${permitted}/plain.png`), "shown", "an image on a host the extension can access");
  eq(await create(`${permitted}/redirect?to=${encodeURIComponent(`${other}/plain.png`)}`), failed, "a redirect to a site without access");
  eq(await create(`${permitted}/redirect?to=${encodeURIComponent(`${other}/cors.png`)}`), "shown", "a redirect to a site that allows CORS");
  eq(await create(`${permitted}/big`), failed, "an image over the size limit");
  const started = Date.now();
  eq(await create(`${permitted}/slow`), failed, "an image that never arrives in time");
  check(Date.now() - started < 2500, `slow image gave up after ${Date.now() - started}ms`);
  eq(cookies.filter(Boolean), [], "no request carried the user's cookies");
  server.close();
});

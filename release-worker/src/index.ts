interface Env {
  RELEASES: R2Bucket;
  STATS: D1Database;
  STATS_KEY: string;
}

type PlatformBuild = {
  file: string;
  sha256: string;
  size: number;
};

type Manifest = {
  version: string;
  channel: string;
  published: string;
  platforms: Record<string, PlatformBuild>;
};

const CHANNELS = ["stable", "dev"] as const;
type Channel = (typeof CHANNELS)[number];

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

const notFound = () => new Response("not found\n", { status: 404 });

async function readManifest(env: Env, key: string): Promise<Manifest | null> {
  const object = await env.RELEASES.get(key);
  if (!object) return null;
  return object.json<Manifest>();
}

const downloadUrl = (base: string, manifest: Manifest, build: PlatformBuild) =>
  `${base}/dl/${manifest.channel}/${manifest.version}/${build.file}`;

// The installer lives in R2 next to the tarball rather than inside this bundle:
// uploading shell text as part of a Worker trips Cloudflare's own WAF, and this
// way a pinned version serves the installer that shipped with it.
async function renderInstaller(env: Env, manifest: Manifest, base: string): Promise<string | null> {
  const object = await env.RELEASES.get(`${manifest.channel}/${manifest.version}/install.sh`);
  if (!object) return null;
  const table = Object.entries(manifest.platforms)
    .map(([target, build]) => `${target} ${downloadUrl(base, manifest, build)} ${build.sha256} ${build.size}`)
    .join("\n");
  return (await object.text())
    .replaceAll("__PLATFORMS__", table)
    .replaceAll("__VERSION__", manifest.version)
    .replaceAll("__CHANNEL__", manifest.channel);
}

async function installerResponse(env: Env, manifest: Manifest, base: string): Promise<Response> {
  const script = await renderInstaller(env, manifest, base);
  if (!script) return new Response("installer missing for this release\n", { status: 500 });
  return shellResponse(script);
}

const shellResponse = (body: string) =>
  new Response(body, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const jsonResponse = (value: unknown, status = 200) =>
  new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

// Hashing first keeps the comparison constant-time even when the lengths differ.
async function keyMatches(request: Request, env: Env): Promise<boolean> {
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided || !env.STATS_KEY) return false;
  const [a, b] = await Promise.all([digest(provided), digest(env.STATS_KEY)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function recordDownload(
  env: Env,
  ctx: ExecutionContext,
  channel: string,
  version: string,
) {
  const day = new Date().toISOString().slice(0, 10);
  ctx.waitUntil(
    env.STATS.prepare(
      `INSERT INTO downloads (version, day, channel, count) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (version, day, channel) DO UPDATE SET count = count + 1`,
    )
      .bind(version, day, channel)
      .run()
      .then(() => undefined)
      .catch((error) => {
        console.error("download count failed", error);
      }),
  );
}

async function serveDownload(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  channel: string,
  version: string,
  file: string,
): Promise<Response> {
  const range = request.headers.get("range");
  const object = await env.RELEASES.get(`${channel}/${version}/${file}`, {
    range: range ? request.headers : undefined,
    onlyIf: request.headers,
  });
  if (!object) return notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");

  const body = "body" in object ? object.body : null;
  if (!body) return new Response(null, { status: 304, headers });

  // A resumed download arrives with a range, so only unranged requests are
  // counted — otherwise one install could register several times.
  if (!range && request.method === "GET") {
    recordDownload(env, ctx, channel, version);
  }

  // R2 reports a range on unranged reads too, so the request header is what
  // decides between 200 and 206.
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { headers });
}

async function serveStats(request: Request, env: Env): Promise<Response> {
  if (!(await keyMatches(request, env))) return notFound();

  const params = new URL(request.url).searchParams;
  const since = params.get("since") ?? "0000-00-00";
  const channel = params.get("channel");
  const byDay = params.get("by") === "day";

  const where = channel ? "WHERE day >= ?1 AND channel = ?2" : "WHERE day >= ?1";
  const bind = channel ? [since, channel] : [since];

  const query = byDay
    ? `SELECT version, channel, day, count FROM downloads ${where} ORDER BY day DESC, count DESC`
    : `SELECT version, channel, SUM(count) AS count, MIN(day) AS first, MAX(day) AS last
       FROM downloads ${where} GROUP BY version, channel ORDER BY count DESC`;

  const { results } = await env.STATS.prepare(query)
    .bind(...bind)
    .all();

  const rows = (results ?? []) as Array<Record<string, unknown>>;
  const total = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  return jsonResponse({ total, since, [byDay ? "days" : "versions"]: rows });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requested = url.pathname.replace(/\/+$/, "");
    // On a custom domain the marketing site owns "/", so the worker also answers
    // under an /install prefix and serves the same routes beneath it.
    const prefix = requested === "/install" || requested.startsWith("/install/") ? "/install" : "";
    const path = requested.slice(prefix.length);
    const segments = path.split("/").filter(Boolean);
    const origin = url.origin;
    const installBase = origin + prefix;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405 });
    }

    if (path === "/stats" || path === "/stats/") return serveStats(request, env);

    if (segments[0] === "dl" && segments.length === 4) {
      const [, channel, version, file] = segments;
      if (!isChannel(channel)) return notFound();
      return serveDownload(request, env, ctx, channel, version, file);
    }

    if (path === "/latest.json" || path === "/dev/latest.json") {
      const channel: Channel = path.startsWith("/dev") ? "dev" : "stable";
      const manifest = await readManifest(env, `${channel}/latest.json`);
      if (!manifest) return notFound();
      return jsonResponse({
        ...manifest,
        platforms: Object.fromEntries(
          Object.entries(manifest.platforms).map(([target, build]) => [
            target,
            { ...build, url: downloadUrl(installBase, manifest, build) },
          ]),
        ),
        install: channel === "dev" ? `${installBase}/dev` : installBase,
      });
    }

    if (segments[0] === "v" && segments.length === 2) {
      const version = segments[1];
      for (const channel of CHANNELS) {
        const manifest = await readManifest(env, `${channel}/${version}/manifest.json`);
        if (manifest) return installerResponse(env, manifest, installBase);
      }
      return notFound();
    }

    if (path === "" || path === "/dev") {
      const channel: Channel = path === "/dev" ? "dev" : "stable";
      const manifest = await readManifest(env, `${channel}/latest.json`);
      if (!manifest) return new Response("no release published yet\n", { status: 503 });
      return installerResponse(env, manifest, installBase);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;

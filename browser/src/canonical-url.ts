// Chromium parses these like http(s): the host is lowercased and
// percent-decoded, "\" counts as "/", and the "//" may be missing. The WHATWG
// parser in Node treats them as opaque instead, so a spelling such as
// "CHROME-EXTENSION:\\ID" would look different here than it does to Chromium.
const HOST_SCHEMES = new Set(["chrome-extension", "chrome", "chrome-untrusted", "devtools", "terminal-browser", "terminal-browser-file"]);
const INNER_ORIGIN_SCHEMES = new Set(["blob", "filesystem"]);
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export interface CanonicalUrl {
  scheme: string;
  host: string;
  origin: string | null;
  href: string;
  pathname: string;
}

function clean(input: string): string {
  return input.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
}

function parse(input: string, base?: string): URL | null {
  try {
    return new URL(input, base);
  } catch {
    return null;
  }
}

function hostUrl(scheme: string, rest: string, base: CanonicalUrl | null): CanonicalUrl | null {
  const baseTail = base ? `//${base.host}${base.pathname}` : undefined;
  const http = parse(`http:${rest}`, baseTail && `http:${baseTail}`);
  const https = parse(`https:${rest}`, baseTail && `https:${baseTail}`);
  if (!http || !https || http.protocol !== "http:" || !http.hostname) return null;
  if (http.username || http.password || http.port || https.port) return null;
  const origin = `${scheme}://${http.hostname}`;
  return { scheme, host: http.hostname, origin, href: `${origin}${http.pathname}${http.search}${http.hash}`, pathname: http.pathname };
}

// Parses a URL the way Chromium would before it is handed to Chromium, so
// checks on the scheme, host and origin see what Chromium will act on.
export function canonicalUrl(input: string, base?: string): CanonicalUrl | null {
  const cleaned = clean(input);
  const ownScheme = SCHEME.exec(cleaned)?.[1].toLowerCase() ?? null;
  const parsedBase = base === undefined ? null : canonicalUrl(base);
  if (base !== undefined && !parsedBase) return null;
  const scheme = ownScheme ?? parsedBase?.scheme;
  if (!scheme) return null;
  if (HOST_SCHEMES.has(scheme)) {
    const rest = ownScheme ? cleaned.slice(ownScheme.length + 1) : cleaned;
    return hostUrl(scheme, rest, parsedBase?.scheme === scheme ? parsedBase : null);
  }
  const url = parse(cleaned, parsedBase?.href);
  if (!url) return null;
  const urlScheme = url.protocol.slice(0, -1);
  return { scheme: urlScheme, host: url.host, origin: originOf(url, urlScheme), href: url.href, pathname: url.pathname };
}

function originOf(url: URL, scheme: string): string | null {
  if (INNER_ORIGIN_SCHEMES.has(scheme)) return canonicalUrl(url.pathname)?.origin ?? null;
  if (scheme === "file") return "file://";
  return url.origin === "null" ? null : url.origin;
}

export function canonicalOrigin(input: string): string | null {
  return canonicalUrl(input)?.origin ?? null;
}

export function extensionIdOfUrl(input: string): string | null {
  const url = canonicalUrl(input);
  return url?.scheme === "chrome-extension" && /^[a-p]{32}$/.test(url.host) ? url.host : null;
}

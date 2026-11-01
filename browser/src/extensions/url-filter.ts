// Chrome's events.UrlFilter (components/url_matcher), used by filtered events
// such as chrome.webNavigation.*.addListener(listener, { url: [...] }).
export interface UrlFilter {
  hostContains?: string;
  hostEquals?: string;
  hostPrefix?: string;
  hostSuffix?: string;
  pathContains?: string;
  pathEquals?: string;
  pathPrefix?: string;
  pathSuffix?: string;
  queryContains?: string;
  queryEquals?: string;
  queryPrefix?: string;
  querySuffix?: string;
  urlContains?: string;
  urlEquals?: string;
  urlMatches?: string;
  originAndPathMatches?: string;
  urlPrefix?: string;
  urlSuffix?: string;
  schemes?: string[];
  ports?: (number | [number, number])[];
  cidrBlocks?: string[];
}

const QUERY_DELIMITER = "\u0004";

function hostSuffix(host: string): string {
  const trimmed = host.replace(/\.+$/, "");
  return trimmed ? `${trimmed}.` : ".";
}

function hostPrefix(host: string): string {
  if (!host) return ".";
  return host.startsWith(".") ? host : `.${host}`;
}

function canonicalHost(host: string): string {
  return hostPrefix(hostSuffix(host));
}

function canonicalQuery(query: string, prepend: boolean, append: boolean): string {
  const body = query.replaceAll("&", QUERY_DELIMITER);
  return `${prepend ? QUERY_DELIMITER : ""}${body}${append ? QUERY_DELIMITER : ""}`;
}

function withoutQuestionMark(value: string): string {
  return value.startsWith("?") ? value.slice(1) : value;
}

function defaultPort(protocol: string): number | null {
  const ports: Record<string, number> = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443, "ftp:": 21 };
  return ports[protocol] ?? null;
}

function ipv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}

function inCidr(host: string, block: string): boolean {
  const [base, bits] = block.split("/");
  const address = ipv4(host);
  const network = ipv4(base);
  const size = Number(bits ?? 32);
  if (address === null || network === null || !(size >= 0 && size <= 32)) return false;
  const blockSize = Math.pow(2, 32 - size);
  return Math.floor(address / blockSize) === Math.floor(network / blockSize);
}

function regexMatches(source: string, text: string): boolean {
  try {
    return new RegExp(source).test(text);
  } catch {
    return false;
  }
}

export function urlFilterMatches(filter: UrlFilter, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  const host = url.hostname;
  const path = url.pathname;
  const query = url.search.replace(/^\?/, "");
  const full = url.href.replace(/#$/, "");
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  const canonical = canonicalHost(host);
  const componentQuery = query ? canonicalQuery(query, true, true) : "";
  const checks: (() => boolean)[] = [];
  const add = (value: unknown, test: (value: string) => boolean) => {
    if (value !== undefined) checks.push(() => typeof value === "string" && test(value));
  };
  add(filter.hostContains, (v) => canonical.includes(v));
  add(filter.hostEquals, (v) => canonical === canonicalHost(v));
  add(filter.hostPrefix, (v) => canonical.startsWith(hostPrefix(v)));
  add(filter.hostSuffix, (v) => canonical.endsWith(hostSuffix(v)));
  add(filter.pathContains, (v) => path.includes(v));
  add(filter.pathEquals, (v) => path === v);
  add(filter.pathPrefix, (v) => path.startsWith(v));
  add(filter.pathSuffix, (v) => path.endsWith(v));
  add(filter.queryContains, (v) =>
    v.startsWith("?") ? componentQuery.startsWith(canonicalQuery(withoutQuestionMark(v), true, false)) : query.includes(v),
  );
  add(filter.queryEquals, (v) => componentQuery === canonicalQuery(withoutQuestionMark(v), true, true));
  add(filter.queryPrefix, (v) => componentQuery.startsWith(canonicalQuery(withoutQuestionMark(v), true, false)));
  add(filter.querySuffix, (v) =>
    v.startsWith("?")
      ? componentQuery === canonicalQuery(withoutQuestionMark(v), true, true)
      : componentQuery.endsWith(canonicalQuery(v, false, true)),
  );
  add(filter.urlContains, (v) => full.includes(v));
  add(filter.urlEquals, (v) => full === v);
  add(filter.urlPrefix, (v) => full.startsWith(v));
  add(filter.urlSuffix, (v) => full.endsWith(v));
  add(filter.urlMatches, (v) => regexMatches(v, full));
  add(filter.originAndPathMatches, (v) => regexMatches(v, `${url.origin}${path}`));
  if (filter.schemes !== undefined) checks.push(() => filter.schemes!.includes(url.protocol.slice(0, -1)));
  if (filter.ports !== undefined) {
    checks.push(() =>
      filter.ports!.some((entry) => (Array.isArray(entry) ? port !== null && port >= entry[0] && port <= entry[1] : entry === port)),
    );
  }
  if (filter.cidrBlocks !== undefined) checks.push(() => filter.cidrBlocks!.some((block) => inCidr(host, block)));
  return checks.every((check) => check());
}

// An event filter like {url: [UrlFilter, ...]} matches when any UrlFilter does.
export function eventUrlFilterMatches(filter: unknown, url: string): boolean {
  const filters = (filter as { url?: UrlFilter[] } | null)?.url;
  if (!Array.isArray(filters) || filters.length === 0) return true;
  return filters.some((entry) => urlFilterMatches(entry ?? {}, url));
}

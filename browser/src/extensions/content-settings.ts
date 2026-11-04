import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import { ensureOwnedDir, sitePermission, writePrivateFile } from "shared";

export type Setting = "allow" | "block" | "ask" | "session_only";

// A site pattern as Chrome stores it (components/content_settings ContentSettingsPattern).
// null means "any" for scheme, port and path; a domain wildcard with an empty host matches every host.
export interface Pattern {
  scheme: string | null;
  host: string;
  domainWildcard: boolean;
  port: string | null;
  path: string | null;
}

export const WILDCARD: Pattern = { scheme: null, host: "", domainWildcard: true, port: null, path: null };

interface TypeInfo {
  initial: Setting;
  valid: Setting[];
  // Pages on these schemes always get "allow", like Chrome's own pages.
  allowlisted: string[];
  embeddedPatterns: boolean;
  // tb's remembered answers to its permission prompt for this type.
  promptKinds: string[];
}

const PAGE_SCHEMES = ["chrome", "devtools", "chrome-extension", "chrome-untrusted"];
const INTERNAL_SCHEMES = ["terminal-browser", "terminal-browser-file"];

// The types an extension can change, by Chrome's internal name. Their initial values are what
// terminal-browser does without a rule, which differs from Chrome for popups and automatic
// downloads (never limited) and location (never granted).
export const CONTENT_TYPES: Record<string, TypeInfo> = {
  cookies: { initial: "allow", valid: ["allow", "block", "session_only"], allowlisted: ["chrome", "devtools"], embeddedPatterns: true, promptKinds: [] },
  images: { initial: "allow", valid: ["allow", "block"], allowlisted: PAGE_SCHEMES, embeddedPatterns: false, promptKinds: [] },
  javascript: { initial: "allow", valid: ["allow", "block"], allowlisted: PAGE_SCHEMES, embeddedPatterns: false, promptKinds: [] },
  popups: { initial: "allow", valid: ["allow", "block"], allowlisted: ["chrome", "devtools", "chrome-extension"], embeddedPatterns: false, promptKinds: [] },
  geolocation: { initial: "block", valid: ["allow", "block", "ask"], allowlisted: [], embeddedPatterns: false, promptKinds: [] },
  notifications: { initial: "ask", valid: ["allow", "block", "ask"], allowlisted: [], embeddedPatterns: false, promptKinds: ["notifications"] },
  "media-stream-mic": { initial: "ask", valid: ["allow", "block", "ask"], allowlisted: ["chrome", "devtools"], embeddedPatterns: false, promptKinds: ["media:audio"] },
  "media-stream-camera": { initial: "ask", valid: ["allow", "block", "ask"], allowlisted: ["chrome", "devtools"], embeddedPatterns: false, promptKinds: ["media:video"] },
  clipboard: { initial: "ask", valid: ["allow", "block", "ask"], allowlisted: ["chrome"], embeddedPatterns: false, promptKinds: ["clipboard-read"] },
  "automatic-downloads": { initial: "allow", valid: ["allow", "block", "ask"], allowlisted: ["chrome", "devtools", "chrome-extension"], embeddedPatterns: false, promptKinds: [] },
  sound: { initial: "allow", valid: ["allow", "block"], allowlisted: [], embeddedPatterns: false, promptKinds: [] },
  "anti-abuse": { initial: "allow", valid: ["allow", "block"], allowlisted: [], embeddedPatterns: false, promptKinds: [] },
};

const PARSE_ERRORS = {
  missingSeparator: "Missing scheme separator.",
  scheme: "Invalid scheme.",
  wrongSeparator: "Wrong scheme type.",
  emptyHost: "Host can not be empty.",
  hostWildcard: "Invalid host wildcard.",
  emptyPath: "Empty path.",
  port: "Invalid port.",
  host: "Invalid host.",
};
// Chrome sends this one with the asterisk left in.
const INVALID_PATTERN = 'The pattern "*" is invalid.';

function canonicalHost(host: string): string | null {
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
}

function isIpAddress(host: string): boolean {
  return host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function defaultPort(scheme: string): string {
  return scheme === "http" ? "80" : scheme === "https" ? "443" : "";
}

// Like Chrome's content_settings_helpers::ParseExtensionPattern: an extension match pattern
// for http, https or file, without paths (file patterns name one exact path).
export function parsePattern(source: string): { pattern: Pattern } | { error: string } {
  const fail = (error: string) => ({ error });
  let scheme = "*";
  let host = "";
  let matchSubdomains = true;
  let port = "*";
  let rawPath = "/*";
  if (source !== "<all_urls>") {
    matchSubdomains = false;
    let end = source.indexOf("://");
    const standardSeparator = end >= 0;
    if (end < 0) end = source.indexOf(":");
    if (end < 0) return fail(PARSE_ERRORS.missingSeparator);
    scheme = source.slice(0, end);
    if (!["*", "http", "https", "file"].includes(scheme)) return fail(PARSE_ERRORS.scheme);
    if (!standardSeparator) return fail(PARSE_ERRORS.wrongSeparator);
    const hostStart = end + 3;
    if (hostStart >= source.length) return fail(PARSE_ERRORS.emptyHost);
    let pathStart: number;
    if (scheme === "file") {
      const hostEnd = source.indexOf("/", hostStart);
      pathStart = hostEnd < 0 ? hostStart - 1 : hostEnd;
    } else {
      const hostEnd = source.indexOf("/", hostStart);
      if (hostEnd === hostStart) return fail(PARSE_ERRORS.emptyHost);
      if (hostEnd < 0) return fail(PARSE_ERRORS.emptyPath);
      const hostAndPort = source.slice(hostStart, hostEnd);
      let portAt = -1;
      if (hostAndPort[0] !== "[") {
        portAt = hostAndPort.indexOf(":");
      } else {
        const closing = hostAndPort.indexOf("]");
        if (closing < 0) return fail(PARSE_ERRORS.host);
        if (closing === 1) return fail(PARSE_ERRORS.emptyHost);
        if (closing < hostAndPort.length - 1) {
          if (hostAndPort[closing + 1] !== ":") return fail(PARSE_ERRORS.host);
          portAt = closing + 1;
        }
      }
      if (portAt >= 0) {
        port = hostAndPort.slice(portAt + 1);
        const numeric = /^\d+$/.test(port) && Number(port) < 65536;
        if (port !== "*" && (scheme === "*" || !numeric)) return fail(PARSE_ERRORS.port);
      }
      let hostPiece = portAt >= 0 ? hostAndPort.slice(0, portAt) : hostAndPort;
      if (hostPiece === "") return fail(PARSE_ERRORS.emptyHost);
      if (hostPiece === "*") {
        matchSubdomains = true;
        hostPiece = "";
      } else if (hostPiece.startsWith("*.")) {
        if (hostPiece.length === 2) return fail(PARSE_ERRORS.emptyHost);
        matchSubdomains = true;
        hostPiece = hostPiece.slice(2);
      }
      host = hostPiece;
      pathStart = hostEnd;
    }
    rawPath = source.slice(pathStart);
    if (host.includes("*")) return fail(PARSE_ERRORS.hostWildcard);
    if (host) {
      const canonical = canonicalHost(host);
      if (!canonical || canonical.includes("\0")) return fail(PARSE_ERRORS.host);
      host = canonical;
    }
  }

  let filePath: string | null = null;
  if (scheme === "file") {
    if (/[*?]/.test(rawPath)) return fail("Path wildcards in file URL patterns are not allowed.");
    filePath = rawPath;
  } else if (rawPath !== "/*") {
    return fail("Specific paths are not allowed.");
  }
  const pattern = buildPattern(scheme === "*" ? null : scheme, host, matchSubdomains, port === "*" ? null : port, filePath);
  return pattern ? { pattern } : fail(INVALID_PATTERN);
}

function buildPattern(scheme: string | null, rawHost: string, domainWildcard: boolean, port: string | null, rawPath: string | null): Pattern | null {
  let filePath = rawPath;
  if (scheme === "file" && filePath !== null) {
    for (;;) {
      let canonical: string;
      try {
        canonical = new URL(`file://${filePath}`).pathname;
      } catch {
        return null;
      }
      if (canonical === filePath) break;
      filePath = canonical;
    }
  }
  let host = rawHost;
  if (host && isIpAddress(host) && domainWildcard) return null;
  if (domainWildcard && host.startsWith(".")) return null;
  if (host.endsWith("..")) return null;
  if (host.length >= 2 && host.endsWith(".")) host = host.slice(0, -1);
  if (scheme === "file") {
    if (domainWildcard || host || port !== null) return null;
    if (!filePath || filePath === "/" || filePath.includes("*")) return null;
    return { scheme, host: "", domainWildcard: false, port: null, path: filePath };
  }
  if (!host && !domainWildcard) return null;
  return { scheme, host, domainWildcard, port, path: null };
}

function isSubDomainOrEqual(sub: string, domain: string): boolean {
  if (domain === "" || sub === domain) return true;
  return sub.length > domain.length && sub.endsWith(domain) && sub[sub.length - domain.length - 1] === ".";
}

export function patternMatches(pattern: Pattern, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (pattern.scheme !== null && pattern.scheme !== scheme) return false;
  if (pattern.scheme !== null && scheme === "file") return pattern.path === null || pattern.path === parsed.pathname;
  let host = parsed.hostname;
  if (host.length > 1 && host.endsWith(".")) host = host.slice(0, -1);
  if (pattern.domainWildcard ? !isSubDomainOrEqual(host, pattern.host) : pattern.host !== host) return false;
  const port = parsed.port || defaultPort(scheme);
  return pattern.port === null || pattern.port === port;
}

function compareDomains(a: string, b: string): number {
  const left = a.split(".").reverse();
  const right = b.split(".").reverse();
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}

// ContentSettingsPattern::Relation: which of two patterns wins when both match.
export const enum Relation {
  DisjointPost = -2,
  Successor = -1,
  Identity = 0,
  Predecessor = 1,
  DisjointPre = 2,
}

function compareWildcards(a: boolean, b: boolean, x: string, y: string): Relation {
  if (a && !b) return Relation.Successor;
  if (!a && b) return Relation.Predecessor;
  if (x === y) return Relation.Identity;
  return x > y ? Relation.DisjointPre : Relation.DisjointPost;
}

function compareHosts(a: Pattern, b: Pattern): Relation {
  const order = compareDomains(a.host, b.host) < 0 ? Relation.DisjointPre : Relation.DisjointPost;
  if (!a.domainWildcard && !b.domainWildcard) return a.host === b.host ? Relation.Identity : order;
  if (a.domainWildcard && !b.domainWildcard) return isSubDomainOrEqual(b.host, a.host) ? Relation.Successor : order;
  if (!a.domainWildcard && b.domainWildcard) return isSubDomainOrEqual(a.host, b.host) ? Relation.Predecessor : order;
  if (a.host === b.host) return Relation.Identity;
  if (isSubDomainOrEqual(b.host, a.host)) return Relation.Successor;
  if (isSubDomainOrEqual(a.host, b.host)) return Relation.Predecessor;
  return order;
}

export function comparePatterns(a: Pattern, b: Pattern): Relation {
  const relations = [
    compareHosts(a, b),
    compareWildcards(a.port === null, b.port === null, a.port ?? "", b.port ?? ""),
    compareWildcards(a.scheme === null, b.scheme === null, a.scheme ?? "", b.scheme ?? ""),
    a.scheme === "file" && b.scheme === "file"
      ? compareWildcards(a.path === null, b.path === null, a.path ?? "", b.path ?? "")
      : Relation.Identity,
  ];
  const disjoint = relations.find((relation) => relation === Relation.DisjointPre || relation === Relation.DisjointPost);
  return disjoint ?? relations.find((relation) => relation !== Relation.Identity) ?? Relation.Identity;
}

export function samePattern(a: Pattern, b: Pattern): boolean {
  return comparePatterns(a, b) === Relation.Identity;
}

export function isWildcard(pattern: Pattern): boolean {
  return samePattern(pattern, WILDCARD);
}

export interface ContentRule {
  primary: Pattern;
  secondary: Pattern;
  setting: Setting;
}

type Rules = Record<string, ContentRule[]>;

export interface ContentSettingsHost {
  readonly loaded: ReadonlyMap<string, { readonly record: { readonly installedAt: number } }>;
  onUnload(listener: (id: string) => void): unknown;
  onUninstall(listener: (id: string) => void): unknown;
  onChange(listener: () => void): unknown;
}

function settingsFile(extensionId: string): string {
  const dir = path.join(app.getPath("userData"), "extension-content-settings");
  ensureOwnedDir(dir);
  return path.join(dir, `${extensionId}.json`);
}

function schemeOf(url: string): string {
  const colon = url.indexOf(":");
  return colon < 0 ? "" : url.slice(0, colon).toLowerCase();
}

// chrome.contentSettings rules per extension, like Chrome's ContentSettingsStore: only loaded
// extensions' rules apply, the most recently installed extension's first.
export class ContentSettingsStore {
  private readonly rules = new Map<string, Rules>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: ContentSettingsHost) {
    host.onUnload((id) => {
      this.rules.delete(id);
      this.notify();
    });
    host.onUninstall((id) => fs.rmSync(settingsFile(id), { force: true }));
    host.onChange(() => this.notify());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }

  private load(extensionId: string): Rules {
    let rules = this.rules.get(extensionId);
    if (!rules) {
      try {
        rules = JSON.parse(fs.readFileSync(settingsFile(extensionId), "utf8")) as Rules;
      } catch {
        rules = {};
      }
      this.rules.set(extensionId, rules);
    }
    return rules;
  }

  private save(extensionId: string, rules: Rules) {
    this.rules.set(extensionId, rules);
    if (Object.values(rules).every((list) => list.length === 0)) fs.rmSync(settingsFile(extensionId), { force: true });
    else writePrivateFile(settingsFile(extensionId), JSON.stringify(rules));
    this.notify();
  }

  set(extensionId: string, type: string, primary: Pattern, secondary: Pattern, setting: Setting) {
    const rules = this.load(extensionId);
    const kept = (rules[type] ?? []).filter((rule) => !samePattern(rule.primary, primary) || !samePattern(rule.secondary, secondary));
    this.save(extensionId, { ...rules, [type]: [...kept, { primary, secondary, setting }] });
  }

  clear(extensionId: string, type: string) {
    const rules = this.load(extensionId);
    if (!rules[type]) return;
    const { [type]: _cleared, ...rest } = rules;
    this.save(extensionId, rest);
  }

  ownRules(extensionId: string, type: string): ContentRule[] {
    return [...(this.load(extensionId)[type] ?? [])];
  }

  private byPrecedence(): string[] {
    return [...this.host.loaded.entries()]
      .sort(([a, first], [b, second]) => second.record.installedAt - first.record.installedAt || (a < b ? -1 : 1))
      .map(([id]) => id);
  }

  // Changes whenever the rules that apply for these types do.
  rulesKey(types: string[]): string {
    return JSON.stringify(this.byPrecedence().map((id) => [id, types.map((type) => this.load(id)[type] ?? [])]));
  }

  hasRules(type: string): boolean {
    return this.byPrecedence().some((id) => (this.load(id)[type]?.length ?? 0) > 0);
  }

  rule(type: string, primaryUrl: string, secondaryUrl: string): Setting | null {
    for (const id of this.byPrecedence()) {
      let best: ContentRule | null = null;
      for (const candidate of this.load(id)[type] ?? []) {
        if (!patternMatches(candidate.primary, primaryUrl) || !patternMatches(candidate.secondary, secondaryUrl)) continue;
        if (!best) {
          best = candidate;
          continue;
        }
        const primary = comparePatterns(candidate.primary, best.primary);
        const relation = primary === Relation.Identity ? comparePatterns(candidate.secondary, best.secondary) : primary;
        if (relation > 0) best = candidate;
      }
      if (best) return best.setting;
    }
    return null;
  }

  // What a page at primaryUrl gets, like Chrome's HostContentSettingsMap: extension rules,
  // then the user's own answers to terminal-browser's prompt, then the default.
  effective(type: string, primaryUrl: string, secondaryUrl: string): Setting {
    const info = CONTENT_TYPES[type];
    const scheme = schemeOf(primaryUrl);
    if (INTERNAL_SCHEMES.includes(scheme) || info.allowlisted.includes(scheme)) return "allow";
    const ruled = this.rule(type, primaryUrl, secondaryUrl);
    if (ruled) return ruled;
    if (info.promptKinds.length > 0) {
      let origin = "";
      try {
        origin = new URL(primaryUrl).origin;
      } catch {}
      if (origin && origin !== "null") {
        const answers = info.promptKinds.map((kind) => sitePermission(origin, origin, kind));
        if (answers.some((answer) => answer === false)) return "block";
        if (answers.every((answer) => answer === true)) return "allow";
      }
    }
    return info.initial;
  }

  // The extension rule for a document in a tab showing topUrl; terminal-browser's own pages never have one.
  ruleForPage(type: string, topUrl: string, documentUrl = topUrl): Setting | null {
    const scheme = schemeOf(topUrl);
    if (INTERNAL_SCHEMES.includes(scheme) || CONTENT_TYPES[type].allowlisted.includes(scheme)) return null;
    return this.rule(type, topUrl, documentUrl);
  }

  // Notifications belong to the origin asking, the others to the page it's on, like Chrome.
  permissionRule(check: { permission: string; mediaTypes: string[]; origin: string; embedder: string }): Setting | null {
    const types = permissionTypes(check.permission, check.mediaTypes);
    if (types.length === 0) return null;
    const settings = types.map((type) => this.ruleForPage(type, type === "notifications" ? check.origin : check.embedder));
    if (settings.includes("block")) return "block";
    if (settings.every((setting) => setting === "allow")) return "allow";
    if (settings.includes("ask")) return "ask";
    return null;
  }
}

function permissionTypes(permission: string, mediaTypes: string[]): string[] {
  switch (permission) {
    case "notifications":
      return ["notifications"];
    case "geolocation":
      return ["geolocation"];
    case "clipboard-read":
      return ["clipboard"];
    case "media":
      if (mediaTypes.length === 0) return ["media-stream-camera", "media-stream-mic"];
      return mediaTypes.map((type) => (type === "video" ? "media-stream-camera" : "media-stream-mic"));
    default:
      return [];
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { session } from "electron";
import { keychainGenericPassword } from "pixel-react";

const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const BLOCK_SIZE = 16;
const DOMAIN_HASH_LENGTH = 32;
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

export type CookieEngineFamily = "chromium";

interface SourceBrowserDescriptor {
  slug: string;
  displayName: string;
  aliases: readonly string[];
  family: CookieEngineFamily;
  appNames: readonly string[];
  /** Keychain base names the app/display names do not yield, e.g. Comet ships as "Perplexity Comet". */
  extraKeychainNames: readonly string[];
  darwinRoots: readonly string[];
  linuxRoots: readonly string[];
}

const SOURCE_BROWSERS: readonly SourceBrowserDescriptor[] = [
  {
    slug: "google-chrome",
    displayName: "Google Chrome",
    aliases: ["chrome"],
    family: "chromium",
    appNames: ["Google Chrome.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Google/Chrome"],
    linuxRoots: [".config/google-chrome", ".var/app/com.google.Chrome/config/google-chrome"],
  },
  {
    slug: "brave",
    displayName: "Brave",
    aliases: ["brave-browser"],
    family: "chromium",
    appNames: ["Brave Browser.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/BraveSoftware/Brave-Browser"],
    linuxRoots: [
      ".config/BraveSoftware/Brave-Browser",
      ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
    ],
  },
  {
    slug: "microsoft-edge",
    displayName: "Microsoft Edge",
    aliases: ["edge", "ms-edge"],
    family: "chromium",
    appNames: ["Microsoft Edge.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Microsoft Edge"],
    linuxRoots: [".config/microsoft-edge"],
  },
  {
    slug: "arc",
    displayName: "Arc",
    aliases: [],
    family: "chromium",
    appNames: ["Arc.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Arc/User Data", "Library/Application Support/Arc"],
    linuxRoots: [],
  },
  {
    slug: "opera",
    displayName: "Opera",
    aliases: [],
    family: "chromium",
    appNames: ["Opera.app"],
    extraKeychainNames: [],
    darwinRoots: [
      "Library/Application Support/com.operasoftware.Opera",
      "Library/Application Support/Opera",
    ],
    linuxRoots: [".config/opera"],
  },
  {
    slug: "opera-gx",
    displayName: "Opera GX",
    aliases: ["operagx"],
    family: "chromium",
    appNames: ["Opera GX.app"],
    extraKeychainNames: [],
    darwinRoots: [
      "Library/Application Support/com.operasoftware.OperaGX",
      "Library/Application Support/Opera GX Stable",
    ],
    linuxRoots: [],
  },
  {
    slug: "vivaldi",
    displayName: "Vivaldi",
    aliases: [],
    family: "chromium",
    appNames: ["Vivaldi.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Vivaldi"],
    linuxRoots: [".config/vivaldi"],
  },
  {
    slug: "dia",
    displayName: "Dia",
    aliases: [],
    family: "chromium",
    appNames: ["Dia.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Dia/User Data"],
    linuxRoots: [],
  },
  {
    slug: "perplexity-comet",
    displayName: "Perplexity Comet",
    aliases: ["comet", "perplexity"],
    family: "chromium",
    appNames: ["Perplexity Comet.app", "Comet.app"],
    extraKeychainNames: ["Comet"],
    darwinRoots: ["Library/Application Support/Comet"],
    linuxRoots: [],
  },
  {
    slug: "sigmaos",
    displayName: "SigmaOS",
    aliases: [],
    family: "chromium",
    appNames: ["SigmaOS.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/SigmaOS"],
    linuxRoots: [],
  },
  {
    slug: "sidekick",
    displayName: "Sidekick",
    aliases: [],
    family: "chromium",
    appNames: ["Sidekick.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Sidekick"],
    linuxRoots: [],
  },
  {
    slug: "helium",
    displayName: "Helium",
    aliases: [],
    family: "chromium",
    appNames: ["Helium.app"],
    extraKeychainNames: [],
    darwinRoots: [
      "Library/Application Support/net.imput.helium",
      "Library/Application Support/Helium",
    ],
    linuxRoots: [],
  },
  {
    slug: "atlas",
    displayName: "Atlas",
    aliases: [],
    family: "chromium",
    appNames: ["Atlas.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Atlas"],
    linuxRoots: [],
  },
  {
    slug: "chromium",
    displayName: "Chromium",
    aliases: [],
    family: "chromium",
    appNames: ["Chromium.app"],
    extraKeychainNames: [],
    darwinRoots: ["Library/Application Support/Chromium"],
    linuxRoots: [
      ".config/chromium",
      "snap/chromium/common/chromium",
      ".var/app/org.chromium.Chromium/config/chromium",
    ],
  },
];

export interface CookieImportRequest {
  from?: string;
  profile?: string;
  domain?: string;
}

export interface CookieImportResult {
  browser: string;
  slug: string;
  profile: string;
  profileName: string;
  domains: string[];
  available: string[];
  warnings: string[];
  read: number;
  imported: number;
  undecryptable: number;
  rejected: number;
  sessionOnly: number;
}

export interface CookieSourceProfile {
  /** On-disk directory name, e.g. "Profile 1". */
  directory: string;
  /** The name the operator sees in the browser, e.g. "Work". */
  name: string;
  isDefault: boolean;
  cookiesPath: string;
}

export interface CookieSource {
  slug: string;
  displayName: string;
  family: CookieEngineFamily;
  root: string;
  profiles: CookieSourceProfile[];
}

interface ChromeCookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

function userDataRoots(descriptor: SourceBrowserDescriptor): string[] {
  const home = os.homedir();
  const relative = process.platform === "darwin" ? descriptor.darwinRoots : descriptor.linuxRoots;
  return relative.map((entry) => path.join(home, entry));
}

function readable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function chromiumCookiesPath(profileRoot: string): string | null {
  // Chrome 96+ moved the store under Network/; older profiles still keep it at the top level.
  const modern = path.join(profileRoot, "Network", "Cookies");
  if (readable(modern)) return modern;
  const legacy = path.join(profileRoot, "Cookies");
  return readable(legacy) ? legacy : null;
}

function chromiumProfileNames(root: string): Map<string, string> {
  const names = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8"));
  } catch {
    return names;
  }
  if (!parsed || typeof parsed !== "object" || !("profile" in parsed)) return names;
  const profile = parsed.profile;
  if (!profile || typeof profile !== "object" || !("info_cache" in profile)) return names;
  const cache = profile.info_cache;
  if (!cache || typeof cache !== "object") return names;
  for (const [directory, info] of Object.entries(cache)) {
    if (!info || typeof info !== "object" || !("name" in info)) continue;
    const name = typeof info.name === "string" ? info.name.trim() : "";
    if (name) names.set(directory, name);
  }
  return names;
}

function chromiumProfiles(root: string): CookieSourceProfile[] {
  const names = chromiumProfileNames(root);
  const profiles: CookieSourceProfile[] = [];

  // Opera and friends keep one profile directly in the user-data dir rather than under Default/.
  const rootCookies = chromiumCookiesPath(root);
  if (rootCookies) {
    const directory = path.basename(root);
    profiles.push({
      directory,
      name: names.get(directory) ?? "Default",
      isDefault: true,
      cookiesPath: rootCookies,
    });
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "Network") continue;
    // Chrome's own directories are Default/Profile N/Guest Profile/Person N; anything else
    // is only a profile if Local State names it.
    if (
      !names.has(entry.name) &&
      entry.name !== "Default" &&
      !entry.name.startsWith("Profile ") &&
      !entry.name.startsWith("Guest Profile") &&
      !entry.name.startsWith("Person ")
    ) {
      continue;
    }
    const cookiesPath = chromiumCookiesPath(path.join(root, entry.name));
    if (!cookiesPath) continue;
    profiles.push({
      directory: entry.name,
      name: names.get(entry.name) ?? (entry.name === "Default" ? "Default" : entry.name),
      isDefault: entry.name === "Default",
      cookiesPath,
    });
  }

  return profiles.sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return left.name.localeCompare(right.name) || left.directory.localeCompare(right.directory);
  });
}

interface DetectedSource {
  descriptor: SourceBrowserDescriptor;
  source: CookieSource;
}

function detectSources(): DetectedSource[] {
  const found: DetectedSource[] = [];
  for (const descriptor of SOURCE_BROWSERS) {
    for (const root of userDataRoots(descriptor)) {
      const profiles = chromiumProfiles(root);
      if (profiles.length === 0) continue;
      found.push({
        descriptor,
        source: {
          slug: descriptor.slug,
          displayName: descriptor.displayName,
          family: descriptor.family,
          root,
          profiles,
        },
      });
      break;
    }
  }
  return found;
}

export function listCookieSources(): CookieSource[] {
  return detectSources().map((entry) => entry.source);
}

/** Loose match key: "Microsoft Edge", "microsoft-edge" and "ms edge" all collapse to the same string. */
function looseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findDescriptor(query: string): SourceBrowserDescriptor | null {
  const wanted = looseKey(query);
  if (!wanted) return null;
  for (const descriptor of SOURCE_BROWSERS) {
    const candidates = [
      descriptor.slug,
      descriptor.displayName,
      ...descriptor.aliases,
      ...descriptor.appNames.map((name) => name.replace(/\.app$/, "")),
    ];
    if (candidates.some((candidate) => looseKey(candidate) === wanted)) return descriptor;
  }
  return null;
}

export function resolveCookieSource(query?: string): {
  descriptor: SourceBrowserDescriptor;
  source: CookieSource;
  available: CookieSource[];
} {
  const detected = detectSources();
  const available = detected.map((entry) => entry.source);
  if (!query) {
    const chosen =
      detected.find((entry) => entry.descriptor.slug === "google-chrome") ?? detected[0];
    if (!chosen) {
      throw new Error(
        "no supported browser on this machine has a readable cookie store — " +
          `looked for ${SOURCE_BROWSERS.map((entry) => entry.displayName).join(", ")}`,
      );
    }
    return { descriptor: chosen.descriptor, source: chosen.source, available };
  }

  const descriptor = findDescriptor(query);
  if (!descriptor) {
    throw new Error(
      `--from ${query} is not a browser I know — try one of ` +
        SOURCE_BROWSERS.map((entry) => entry.slug).join(", "),
    );
  }
  const chosen = detected.find((entry) => entry.descriptor.slug === descriptor.slug);
  if (!chosen) {
    const looked = userDataRoots(descriptor);
    const where = looked.length > 0 ? looked.join(", ") : `no ${process.platform} location known`;
    const rest =
      available.length > 0
        ? `installed with cookies: ${available.map((entry) => entry.displayName).join(", ")}`
        : "no supported browser here has a readable cookie store";
    throw new Error(
      `${descriptor.displayName} is not installed — looked in ${where}. ${rest}`,
    );
  }
  return { descriptor, source: chosen.source, available };
}

export function resolveCookieProfile(source: CookieSource, query?: string): CookieSourceProfile {
  if (!query) {
    const profile = source.profiles.find((entry) => entry.isDefault) ?? source.profiles[0];
    if (!profile) throw new Error(`no ${source.displayName} profile with a cookie store`);
    return profile;
  }
  const wanted = query.trim().toLowerCase();
  const byDirectory = source.profiles.filter((entry) => entry.directory.toLowerCase() === wanted);
  const matches =
    byDirectory.length > 0
      ? byDirectory
      : source.profiles.filter((entry) => entry.name.toLowerCase() === wanted);
  if (matches.length > 1) {
    // Chrome does not keep profile names unique; only the directory tells these apart.
    const candidates = matches.map((entry) => `${entry.name} (${entry.directory})`).join(", ");
    throw new Error(
      `${source.displayName} has ${matches.length} profiles called ${query} — ` +
        `pick one by directory: ${candidates}`,
    );
  }
  const match = matches[0];
  if (match) return match;

  const known = source.profiles
    .map((entry) => (entry.name === entry.directory ? entry.directory : `${entry.name} (${entry.directory})`))
    .join(", ");
  throw new Error(`no ${source.displayName} profile ${query} — found ${known}`);
}

function keychainBaseNames(descriptor: SourceBrowserDescriptor): string[] {
  const names: string[] = [];
  const add = (raw: string | undefined) => {
    const name = raw?.trim();
    if (!name || names.includes(name)) return;
    names.push(name);
  };

  add(descriptor.displayName);
  for (const appName of descriptor.appNames) add(appName.replace(/\.app$/, ""));
  // Chrome's item is "Chrome Safe Storage" and Brave's is "Brave Safe Storage", so the
  // vendor prefix and the " Browser" suffix both have to be tried stripped.
  for (const name of [...names]) {
    if (name.startsWith("Google ")) add(name.slice("Google ".length));
    if (name.endsWith(" Browser")) add(name.slice(0, -" Browser".length));
  }
  for (const extra of descriptor.extraKeychainNames) add(extra);
  return names;
}

function chromiumSecret(descriptor: SourceBrowserDescriptor): Buffer {
  if (process.platform !== "darwin") {
    // Chromium on Linux encrypts with a fixed passphrase when no keyring is present.
    return Buffer.from("peanuts", "utf8");
  }
  const tried: string[] = [];
  for (const base of keychainBaseNames(descriptor)) {
    for (const suffix of ["Storage Key", "Safe Storage"]) {
      const service = `${base} ${suffix}`;
      tried.push(service);
      let secret: string | null;
      try {
        secret = keychainGenericPassword(service, base);
      } catch (error) {
        // The key is there but macOS refused it: a denied prompt or a locked keychain.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `your keychain refused the ${descriptor.displayName} cookie key: ${message}`,
        );
      }
      if (secret) return Buffer.from(secret, "utf8");
    }
  }
  throw new Error(
    `could not read a ${descriptor.displayName} cookie key from your keychain — tried ${tried.join(", ")}`,
  );
}

export function deriveKey(secret: Buffer): Buffer {
  return crypto.pbkdf2Sync(secret, SALT, ITERATIONS, KEY_LENGTH, "sha1");
}

export function decryptCookieValue(
  encrypted: Uint8Array,
  key: Buffer,
  host: string,
): string | null {
  const buffer = Buffer.from(encrypted);
  if (buffer.length <= 3) return null;
  const version = buffer.subarray(0, 3).toString("latin1");
  if (version !== "v10" && version !== "v11") return null;
  const body = buffer.subarray(3);
  if (body.length === 0 || body.length % BLOCK_SIZE !== 0) return null;

  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    key,
    Buffer.alloc(BLOCK_SIZE, 0x20),
  );
  decipher.setAutoPadding(false);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }

  // Reject a bad pad rather than truncating blindly: without a MAC it is the only
  // signal that the ciphertext or key was wrong.
  const padding = plain[plain.length - 1] ?? 0;
  if (padding < 1 || padding > BLOCK_SIZE || padding > plain.length) return null;
  for (let at = plain.length - padding; at < plain.length; at += 1) {
    if (plain[at] !== padding) return null;
  }
  plain = plain.subarray(0, plain.length - padding);

  // Chrome 130+ prepends sha256(host) to the plaintext; older versions do not.
  if (plain.length >= DOMAIN_HASH_LENGTH) {
    const expected = crypto.createHash("sha256").update(host, "utf8").digest();
    if (plain.subarray(0, DOMAIN_HASH_LENGTH).equals(expected)) {
      plain = plain.subarray(DOMAIN_HASH_LENGTH);
    }
  }

  return plain.toString("utf8");
}

function sameSite(value: number): "unspecified" | "no_restriction" | "lax" | "strict" {
  switch (value) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

function sweepStaleScratch(): void {
  const root = os.tmpdir();
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith("terminal-browser-cookies-")) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function readRows(cookiesPath: string): ChromeCookieRow[] {
  // A kill between the copy and the cleanup below would otherwise leave the host list on disk.
  sweepStaleScratch();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-cookies-"));
  const copy = path.join(scratch, "Cookies");
  try {
    // Chrome holds the live database open, so read a copy rather than fighting its lock.
    fs.copyFileSync(cookiesPath, copy);
    for (const suffix of ["-wal", "-journal"]) {
      const extra = `${cookiesPath}${suffix}`;
      if (fs.existsSync(extra)) fs.copyFileSync(extra, `${copy}${suffix}`);
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return db
        .prepare(
          // expires_utc is microseconds since 1601 and overflows a JS safe integer, so read it as a double.
          `select host_key, name, value, encrypted_value, path,
                  cast(expires_utc as real) as expires_utc,
                  is_secure, is_httponly, samesite
             from cookies`,
        )
        .all() as unknown as ChromeCookieRow[];
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function parseDomainFilters(raw: string): string[] {
  const filters: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const bare = token
      .trim()
      .toLowerCase()
      .replace(/^\*\./, "")
      .replace(/^\.+/, "");
    if (!bare) continue;
    // A dotless name is almost always a typo like --domain github, but localhost is real.
    if (!bare.includes(".") && bare !== "localhost") {
      throw new Error(`--domain ${token} is not a hostname — use something like github.com`);
    }
    if (!filters.includes(bare)) filters.push(bare);
  }
  // A flag value that survives trimming but yields no hostname is a typo, never a request
  // to copy every cookie.
  if (filters.length === 0) {
    throw new Error(`--domain ${raw} has no hostname in it — use something like github.com`);
  }
  return filters;
}

function matchesDomain(host: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const bare = host.trim().toLowerCase().replace(/^\.+/, "");
  if (!bare) return false;
  return filters.some((filter) => bare === filter || bare.endsWith(`.${filter}`));
}

export async function importChromeCookies(
  request: CookieImportRequest = {},
): Promise<CookieImportResult> {
  const { descriptor, source, available } = resolveCookieSource(request.from);
  const profile = resolveCookieProfile(source, request.profile);
  const domains = request.domain ? parseDomainFilters(request.domain) : [];

  const warnings: string[] = [];
  if (!request.from && available.length > 1) {
    const others = available.filter((entry) => entry.slug !== source.slug);
    warnings.push(
      `imported from ${source.displayName}; also found ${others
        .map((entry) => entry.displayName)
        .join(", ")} — pick one with --from`,
    );
  }

  const secret = chromiumSecret(descriptor);
  const key = deriveKey(secret);
  secret.fill(0);
  const rows = readRows(profile.cookiesPath);
  const store = session.defaultSession.cookies;

  const result: CookieImportResult = {
    browser: source.displayName,
    slug: source.slug,
    profile: profile.directory,
    profileName: profile.name,
    domains,
    available: available.map((entry) => entry.displayName),
    warnings,
    read: 0,
    imported: 0,
    undecryptable: 0,
    rejected: 0,
    sessionOnly: 0,
  };

  for (const row of rows) {
    if (!matchesDomain(row.host_key, domains)) continue;
    result.read += 1;

    const value =
      row.encrypted_value && row.encrypted_value.length > 0
        ? decryptCookieValue(row.encrypted_value, key, row.host_key)
        : row.value;
    if (value === null) {
      result.undecryptable += 1;
      continue;
    }

    if (row.expires_utc === 0) result.sessionOnly += 1;

    const bare = row.host_key.startsWith(".") ? row.host_key.slice(1) : row.host_key;
    const scheme = row.is_secure ? "https" : "http";
    try {
      await store.set({
        url: `${scheme}://${bare}${row.path || "/"}`,
        name: row.name,
        value,
        // A dotless host_key is host-only in Chrome. Sending domain at all would widen it to
        // subdomains, so let Electron derive host-only scope from the url instead.
        ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
        path: row.path || "/",
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        sameSite: sameSite(row.samesite),
        ...(row.expires_utc > 0
          ? { expirationDate: row.expires_utc / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS }
          : {}),
      });
      result.imported += 1;
    } catch {
      // Chrome can hold cookies Electron refuses, e.g. an oversized value.
      result.rejected += 1;
    }
  }

  await store.flushStore();
  return result;
}

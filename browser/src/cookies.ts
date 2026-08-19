import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { session } from "electron";

const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const BLOCK_SIZE = 16;
const DOMAIN_HASH_LENGTH = 32;
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

export interface CookieImportRequest {
  profile?: string;
  domain?: string;
}

export interface CookieImportResult {
  profile: string;
  read: number;
  imported: number;
  undecryptable: number;
  rejected: number;
  sessionOnly: number;
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

export function chromeUserDataDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
  }
  return path.join(home, ".config", "google-chrome");
}

export function listChromeProfiles(root = chromeUserDataDir()): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "Cookies")))
    .map((entry) => entry.name)
    .sort();
}

function keychainSecret(): Buffer {
  if (process.platform !== "darwin") {
    // Chrome on Linux encrypts with a fixed passphrase when no keyring is present.
    return Buffer.from("peanuts", "utf8");
  }
  const found = execFileSync(
    "security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const secret = found.trim();
  if (!secret) throw new Error("the Chrome Safe Storage keychain item is empty");
  return Buffer.from(secret, "utf8");
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

  const padding = plain[plain.length - 1] ?? 0;
  if (padding > 0 && padding <= BLOCK_SIZE && padding <= plain.length) {
    plain = plain.subarray(0, plain.length - padding);
  }

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

function readRows(cookiesPath: string): ChromeCookieRow[] {
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

function matchesDomain(host: string, domain: string): boolean {
  const bare = host.startsWith(".") ? host.slice(1) : host;
  return bare === domain || bare.endsWith(`.${domain}`);
}

export async function importChromeCookies(
  request: CookieImportRequest = {},
): Promise<CookieImportResult> {
  const root = chromeUserDataDir();
  const profiles = listChromeProfiles(root);
  if (profiles.length === 0) {
    throw new Error(`no Chrome profile with a cookie store under ${root}`);
  }
  const profile = request.profile ?? (profiles.includes("Default") ? "Default" : profiles[0]);
  if (!profiles.includes(profile)) {
    throw new Error(`no Chrome profile ${profile} — found ${profiles.join(", ")}`);
  }

  const key = deriveKey(keychainSecret());
  const rows = readRows(path.join(root, profile, "Cookies"));
  const store = session.defaultSession.cookies;

  const result: CookieImportResult = {
    profile,
    read: 0,
    imported: 0,
    undecryptable: 0,
    rejected: 0,
    sessionOnly: 0,
  };

  for (const row of rows) {
    if (request.domain && !matchesDomain(row.host_key, request.domain)) continue;
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
        domain: row.host_key,
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
      // A cookie Chrome accepted can still be rejected here, e.g. __Host- prefixed on a bare domain.
      result.rejected += 1;
    }
  }

  await store.flushStore();
  return result;
}

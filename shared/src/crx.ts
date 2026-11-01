import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Reads, verifies and unpacks CRX3 packages the way Chromium does
// (components/crx_file/crx_verifier.cc), using only node built-ins so both the
// daemon and the CLI can install extensions.

// The SHA-256 of the Chrome Web Store's publisher key (kPublisherKeyHash in crx_verifier.cc).
const WEBSTORE_PUBLISHER_KEY_HASH = Buffer.from([
  0x61, 0xf7, 0xf2, 0xa6, 0xbf, 0xcf, 0x74, 0xcd, 0x0b, 0xc1, 0xfe, 0x24, 0x97, 0xcc, 0x9b, 0x04, 0x25, 0x4c, 0x65,
  0x8f, 0x79, 0xf2, 0x14, 0x53, 0x92, 0x86, 0x7e, 0xa8, 0x36, 0x63, 0x67, 0xcf,
]);

const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\x00", "latin1");
const MAGIC = Buffer.from("Cr24", "latin1");
const MAX_CRX_BYTES = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;

// A recent Chrome version for update requests made outside the browser (the CLI).
export const DEFAULT_PRODVERSION = "152.0.0.0";

export type CrxErrorCode =
  | "not_crx"
  | "crx2"
  | "bad_header"
  | "bad_signature"
  | "missing_proof"
  | "wrong_id"
  | "bad_zip"
  | "not_found"
  | "download_failed";

export class CrxError extends Error {
  constructor(
    readonly code: CrxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface ProtoField {
  field: number;
  wire: number;
  value: Buffer | number;
}

function readVarint(buf: Buffer, at: number): [number, number] {
  let result = 0;
  let scale = 1;
  for (let i = at; i < buf.length && i < at + 10; i++) {
    const byte = buf[i];
    result += (byte & 0x7f) * scale;
    scale *= 128;
    if ((byte & 0x80) === 0) return [result, i + 1];
  }
  throw new CrxError("bad_header", "The CRX header is malformed");
}

function protoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let at = 0;
  while (at < buf.length) {
    const [key, next] = readVarint(buf, at);
    at = next;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const [value, after] = readVarint(buf, at);
      fields.push({ field, wire, value });
      at = after;
    } else if (wire === 2) {
      const [length, after] = readVarint(buf, at);
      if (after + length > buf.length) throw new CrxError("bad_header", "The CRX header is malformed");
      fields.push({ field, wire, value: buf.subarray(after, after + length) });
      at = after + length;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > buf.length) throw new CrxError("bad_header", "The CRX header is malformed");
      fields.push({ field, wire, value: buf.subarray(at, at + size) });
      at += size;
    } else {
      throw new CrxError("bad_header", "The CRX header is malformed");
    }
  }
  return fields;
}

function bytesOf(fields: ProtoField[], field: number): Buffer[] {
  return fields.filter((f) => f.field === field && f.wire === 2).map((f) => f.value as Buffer);
}

interface KeyProof {
  algorithm: "rsa" | "ec";
  publicKey: Buffer;
  signature: Buffer;
}

export interface CrxPackage {
  crxId: Buffer;
  signedHeaderData: Buffer;
  proofs: KeyProof[];
  archive: Buffer;
}

export function parseCrx(file: Buffer): CrxPackage {
  if (file.length < 12 || !file.subarray(0, 4).equals(MAGIC)) {
    throw new CrxError("not_crx", "Not a CRX file");
  }
  const version = file.readUInt32LE(4);
  if (version === 2) throw new CrxError("crx2", "CRX2 packages are no longer supported");
  if (version !== 3) throw new CrxError("bad_header", `Unsupported CRX version ${version}`);
  const headerSize = file.readUInt32LE(8);
  if (12 + headerSize > file.length) throw new CrxError("bad_header", "The CRX header is malformed");
  const header = file.subarray(12, 12 + headerSize);
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd64 = Buffer.from([0x50, 0x4b, 0x06, 0x07]);
  if (header.includes(eocd) || header.includes(eocd64)) {
    throw new CrxError("bad_header", "The CRX header is malformed");
  }
  const fields = protoFields(header);
  const proofs: KeyProof[] = [];
  for (const [field, algorithm] of [
    [2, "rsa"],
    [3, "ec"],
  ] as const) {
    for (const proof of bytesOf(fields, field)) {
      const parts = protoFields(proof);
      proofs.push({ algorithm, publicKey: bytesOf(parts, 1)[0] ?? Buffer.alloc(0), signature: bytesOf(parts, 2)[0] ?? Buffer.alloc(0) });
    }
  }
  const signedHeaderData = bytesOf(fields, 10000)[0] ?? Buffer.alloc(0);
  const crxId = bytesOf(protoFields(signedHeaderData), 1)[0] ?? Buffer.alloc(0);
  return { crxId, signedHeaderData, proofs, archive: file.subarray(12 + headerSize) };
}

function idFromHash(hash: Buffer): string {
  return [...hash.subarray(0, 16).toString("hex")].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

export function extensionIdForKey(publicKey: Buffer): string {
  return idFromHash(crypto.createHash("sha256").update(publicKey).digest());
}

export interface VerifiedCrx {
  id: string;
  // The developer's DER SubjectPublicKeyInfo, which Chrome writes into the
  // unpacked manifest as "key" so the id stays the same.
  publicKey: Buffer;
  fromWebStore: boolean;
  archive: Buffer;
}

export interface VerifyOptions {
  expectedId?: string;
  requireWebStore?: boolean;
}

export function verifyCrx(file: Buffer, options: VerifyOptions = {}): VerifiedCrx {
  const crx = parseCrx(file);
  if (crx.crxId.length !== 16) throw new CrxError("bad_header", "The CRX header has no extension id");
  const declaredId = idFromHash(crx.crxId);
  const sizeOctets = Buffer.alloc(4);
  sizeOctets.writeUInt32LE(crx.signedHeaderData.length);

  let developerKey: Buffer | null = null;
  let fromWebStore = false;
  for (const proof of crx.proofs) {
    let key: crypto.KeyObject;
    try {
      key = crypto.createPublicKey({ key: proof.publicKey, format: "der", type: "spki" });
    } catch {
      throw new CrxError("bad_signature", "The CRX has an invalid public key");
    }
    if (key.asymmetricKeyType !== proof.algorithm) {
      throw new CrxError("bad_signature", "The CRX has an invalid public key");
    }
    const verifier = crypto.createVerify("sha256");
    verifier.update(SIGNATURE_CONTEXT);
    verifier.update(sizeOctets);
    verifier.update(crx.signedHeaderData);
    verifier.update(crx.archive);
    if (!verifier.verify(key, proof.signature)) {
      throw new CrxError("bad_signature", "The CRX signature is invalid");
    }
    const hash = crypto.createHash("sha256").update(proof.publicKey).digest();
    if (idFromHash(hash) === declaredId) developerKey = proof.publicKey;
    if (hash.equals(WEBSTORE_PUBLISHER_KEY_HASH)) fromWebStore = true;
  }
  if (!developerKey) throw new CrxError("missing_proof", "The CRX is not signed by its developer key");
  if (options.requireWebStore && !fromWebStore) {
    throw new CrxError("missing_proof", "The CRX is not signed by the Chrome Web Store");
  }
  if (options.expectedId !== undefined && declaredId !== options.expectedId) {
    throw new CrxError("wrong_id", `The CRX is for ${declaredId}, not ${options.expectedId}`);
  }
  return { id: declaredId, publicKey: developerKey, fromWebStore, archive: crx.archive };
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  offset: number;
  directory: boolean;
  symlink: boolean;
}

function badZip(detail: string): CrxError {
  return new CrxError("bad_zip", `The package archive is invalid: ${detail}`);
}

function readUInt64(buf: Buffer, at: number): number {
  const value = buf.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw badZip("entry too large");
  return Number(value);
}

export function zipEntries(zip: Buffer): ZipEntry[] {
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let at = zip.length - 22; at >= floor; at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw badZip("no end of central directory");
  let count = zip.readUInt16LE(eocd + 10);
  let directoryOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || zip.readUInt32LE(locator) !== 0x07064b50) throw badZip("missing zip64 locator");
    const record = readUInt64(zip, locator + 8);
    if (record + 56 > zip.length || zip.readUInt32LE(record) !== 0x06064b50) throw badZip("missing zip64 record");
    count = readUInt64(zip, record + 32);
    directoryOffset = readUInt64(zip, record + 48);
  }
  if (count > MAX_ENTRIES) throw badZip("too many entries");
  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw badZip("broken central directory");
    const madeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    let compressedSize = zip.readUInt32LE(at + 20);
    let size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const attributes = zip.readUInt32LE(at + 38);
    let offset = zip.readUInt32LE(at + 42);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd + extraLength > zip.length) throw badZip("broken central directory");
    const name = zip.toString("utf8", at + 46, nameEnd);
    let extra = nameEnd;
    while (extra + 4 <= nameEnd + extraLength) {
      const id = zip.readUInt16LE(extra);
      const length = zip.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) {
          size = readUInt64(zip, field);
          field += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = readUInt64(zip, field);
          field += 8;
        }
        if (offset === 0xffffffff) offset = readUInt64(zip, field);
      }
      extra += 4 + length;
    }
    if (flags & 0x1) throw badZip(`${name} is encrypted`);
    const unixMode = madeBy >> 8 === 3 ? attributes >>> 16 : 0;
    entries.push({
      name,
      method,
      compressedSize,
      size,
      crc,
      offset,
      directory: name.endsWith("/"),
      symlink: (unixMode & 0o170000) === 0o120000,
    });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const at = entry.offset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== 0x04034b50) throw badZip(`broken entry ${entry.name}`);
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw badZip(`truncated entry ${entry.name}`);
  const raw = zip.subarray(start, end);
  let data: Buffer;
  if (entry.method === 0) {
    data = raw;
  } else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw badZip(`cannot inflate ${entry.name}`);
    }
  } else {
    throw badZip(`unsupported compression in ${entry.name}`);
  }
  if (data.length !== entry.size) throw badZip(`wrong size for ${entry.name}`);
  if ((zlib.crc32(data) >>> 0) !== entry.crc) throw badZip(`checksum mismatch in ${entry.name}`);
  return data;
}

function safeRelativePath(name: string): string | null {
  if (name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

export function readZipFile(zip: Buffer, name: string): Buffer | null {
  const entry = zipEntries(zip).find((candidate) => safeRelativePath(candidate.name) === name && !candidate.directory);
  return entry ? readZipEntry(zip, entry) : null;
}

// Extracts into a fresh directory next to dest and renames it into place, so a
// failed unpack never leaves a half-written extension behind.
export function unzipTo(zip: Buffer, dest: string): void {
  const entries = zipEntries(zip);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_UNPACKED_BYTES) throw badZip("too large when unpacked");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = fs.mkdtempSync(`${dest}.unpacking-`);
  try {
    for (const entry of entries) {
      if (entry.symlink) continue;
      const relative = safeRelativePath(entry.name);
      if (relative === null) throw badZip(`unsafe path ${JSON.stringify(entry.name)}`);
      const target = path.join(staging, relative);
      if (!target.startsWith(`${staging}${path.sep}`)) throw badZip(`unsafe path ${JSON.stringify(entry.name)}`);
      if (entry.directory) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, readZipEntry(zip, entry), { mode: 0o644, flag: "wx" });
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function storeDownloadUrl(id: string, prodversion = DEFAULT_PRODVERSION): string {
  const x = encodeURIComponent(`id=${id}&uc`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${prodversion}&acceptformat=crx2,crx3&x=${x}`;
}

async function fetchBytes(url: string, notFound: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new CrxError("download_failed", `Download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404 || response.status === 204) throw new CrxError("not_found", notFound);
  if (!response.ok) throw new CrxError("download_failed", `Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_CRX_BYTES) throw new CrxError("download_failed", "Download failed: the package is too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new CrxError("not_found", notFound);
  if (bytes.length > MAX_CRX_BYTES) throw new CrxError("download_failed", "Download failed: the package is too large");
  return bytes;
}

export function downloadStoreCrx(id: string, prodversion = DEFAULT_PRODVERSION): Promise<Buffer> {
  return fetchBytes(storeDownloadUrl(id, prodversion), `${id} is not on the Chrome Web Store`);
}

export interface UpdateInfo {
  id: string;
  version: string;
  codebase: string;
  sha256: string | null;
}

function xmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return attributes;
}

export function parseUpdateResponse(xml: string): UpdateInfo[] {
  const updates: UpdateInfo[] = [];
  for (const app of xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    const id = xmlAttributes(app[1]).appid;
    const check = /<updatecheck\b([^>]*)\/?>/.exec(app[2]);
    if (!id || !check) continue;
    const attributes = xmlAttributes(check[1]);
    if (attributes.status !== "ok" || !attributes.codebase || !attributes.version) continue;
    updates.push({ id, version: attributes.version, codebase: attributes.codebase, sha256: attributes.hash_sha256 ?? null });
  }
  return updates;
}

export async function checkStoreUpdates(
  installed: { id: string; version: string }[],
  prodversion = DEFAULT_PRODVERSION,
): Promise<UpdateInfo[]> {
  if (installed.length === 0) return [];
  const query = installed.map(({ id, version }) => `x=${encodeURIComponent(`id=${id}&v=${version}&uc`)}`).join("&");
  const url = `https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=${prodversion}&acceptformat=crx2,crx3&${query}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new CrxError("download_failed", `Update check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new CrxError("download_failed", `Update check failed: HTTP ${response.status}`);
  const wanted = new Map(installed.map(({ id, version }) => [id, version]));
  return parseUpdateResponse(await response.text()).filter((update) => {
    const current = wanted.get(update.id);
    return current !== undefined && compareVersions(update.version, current) > 0;
  });
}

const AVAILABILITY_BATCH = 25;

// The ids the Web Store would serve to this Chrome version. Removed items and
// Manifest V2 items come back without a package.
export async function storeAvailability(ids: string[], prodversion = DEFAULT_PRODVERSION): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += AVAILABILITY_BATCH) batches.push(unique.slice(start, start + AVAILABILITY_BATCH));
  const found = await Promise.all(
    batches.map((batch) => checkStoreUpdates(batch.map((id) => ({ id, version: "0.0.0.0" })), prodversion)),
  );
  return new Set(found.flat().map((update) => update.id));
}

export async function downloadUpdate(update: UpdateInfo): Promise<Buffer> {
  const url = new URL(update.codebase);
  if (url.protocol !== "https:") throw new CrxError("download_failed", "Update download must use https");
  const bytes = await fetchBytes(update.codebase, `${update.id} is not on the Chrome Web Store`);
  if (update.sha256 && crypto.createHash("sha256").update(bytes).digest("hex") !== update.sha256.toLowerCase()) {
    throw new CrxError("download_failed", "Download failed: the package hash does not match");
  }
  return bytes;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

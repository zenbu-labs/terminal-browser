const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-crx-data-"));

const { CrxError, ManifestError, extensionIdForKey, packageFromCrx, unpackPackage, verifyCrx } = require("../dist/index.js");

const STORE_CRX = fs.readFileSync(path.join(__dirname, "fixtures/json-formatter.crx"));
const STORE_ID = "bcjindcccaagfpapjjmafapmmgkkhgoa";

function varint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function field(number, bytes) {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function zip(files) {
  return zipList(Object.entries(files));
}

// Entries are [name, text, unixMode?], so a list can repeat a name or hold a symlink.
function zipList(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, mode] of files) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(mode === undefined ? 20 : (3 << 8) | 20, 4);
    if (mode !== undefined) central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function keyPair(type = "rsa") {
  const { privateKey, publicKey } =
    type === "rsa"
      ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
      : crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, der: publicKey.export({ type: "spki", format: "der" }) };
}

function idBytes(der) {
  return crypto.createHash("sha256").update(der).digest().subarray(0, 16);
}

// Builds a CRX3 the way Chromium's crx_creator does, signed by every key in `signers`.
function buildCrx({ archive, signers, crxIdFrom = signers[0].der }) {
  const signedHeaderData = field(1, idBytes(crxIdFrom));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedHeaderData.length);
  const proofs = signers.map(({ privateKey, der }) => {
    const sign = crypto.createSign("sha256");
    sign.update(Buffer.from("CRX3 SignedData\x00", "latin1"));
    sign.update(size);
    sign.update(signedHeaderData);
    sign.update(archive);
    const proof = Buffer.concat([field(1, der), field(2, sign.sign(privateKey))]);
    return field(privateKey.asymmetricKeyType === "ec" ? 3 : 2, proof);
  });
  const header = Buffer.concat([...proofs, field(10000, signedHeaderData)]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "latin1");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}

const archive = zip({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Test", version: "1.0" }) });
const developer = keyPair();

function rejects(run, code) {
  assert.throws(run, (error) => error instanceof CrxError && error.code === code);
}

test("a real Chrome Web Store package verifies as a store install", () => {
  const verified = verifyCrx(STORE_CRX, { expectedId: STORE_ID, requireWebStore: true });
  assert.equal(verified.id, STORE_ID);
  assert.equal(verified.fromWebStore, true);
  assert.equal(extensionIdForKey(verified.publicKey), STORE_ID);
  const pkg = packageFromCrx(STORE_CRX, { expectedId: STORE_ID, requireWebStore: true });
  assert.equal(pkg.name, "JSON Formatter");
});

test("a self-signed package verifies, but not as a store install", () => {
  const crx = buildCrx({ archive, signers: [developer] });
  const verified = verifyCrx(crx);
  assert.equal(verified.id, extensionIdForKey(developer.der));
  assert.equal(verified.fromWebStore, false);
  assert.deepEqual(verified.publicKey, developer.der);
  rejects(() => verifyCrx(crx, { requireWebStore: true }), "missing_proof");
});

test("an ECDSA developer key is accepted", () => {
  const ec = keyPair("ec");
  assert.equal(verifyCrx(buildCrx({ archive, signers: [ec] })).id, extensionIdForKey(ec.der));
});

test("a changed payload fails the signature", () => {
  const crx = buildCrx({ archive, signers: [developer] });
  const tampered = Buffer.from(crx);
  tampered[tampered.length - 30] ^= 0xff;
  rejects(() => verifyCrx(tampered), "bad_signature");

  const store = Buffer.from(STORE_CRX);
  store[store.length - 100] ^= 0x01;
  rejects(() => verifyCrx(store, { expectedId: STORE_ID, requireWebStore: true }), "bad_signature");
});

test("a changed header fails", () => {
  const crx = buildCrx({ archive, signers: [developer] });
  const idAt = crx.indexOf(idBytes(developer.der));
  const otherId = Buffer.from(crx);
  otherId[idAt] ^= 0x01;
  rejects(() => verifyCrx(otherId), "bad_signature");

  const truncated = Buffer.from(crx);
  truncated.writeUInt32LE(crx.length, 8);
  rejects(() => verifyCrx(truncated), "bad_header");

  const crx2 = Buffer.from(crx);
  crx2.writeUInt32LE(2, 4);
  rejects(() => verifyCrx(crx2), "crx2");
  rejects(() => verifyCrx(archive), "not_crx");
});

test("a package for another id is refused", () => {
  const crx = buildCrx({ archive, signers: [developer] });
  rejects(() => verifyCrx(crx, { expectedId: STORE_ID }), "wrong_id");
  rejects(() => verifyCrx(STORE_CRX, { expectedId: extensionIdForKey(developer.der) }), "wrong_id");
});

test("an id that no signing key owns is refused", () => {
  const someoneElse = keyPair();
  const crx = buildCrx({ archive, signers: [developer], crxIdFrom: someoneElse.der });
  rejects(() => verifyCrx(crx), "missing_proof");
});

test("a store install needs Google's publisher proof", () => {
  const crx = buildCrx({ archive, signers: [developer, keyPair()] });
  assert.equal(verifyCrx(crx).fromWebStore, false);
  rejects(() => verifyCrx(crx, { requireWebStore: true }), "missing_proof");
});

test("a proof with a mismatched key type is refused", () => {
  const crx = buildCrx({ archive, signers: [developer] });
  const header = crx.readUInt32LE(8);
  const proofTag = crx.indexOf(Buffer.from([0x12]), 12);
  assert.ok(proofTag >= 12 && proofTag < 12 + header);
  const relabeled = Buffer.from(crx);
  relabeled[proofTag] = 0x1a;
  rejects(() => verifyCrx(relabeled), "bad_signature");
});

const shown = JSON.stringify({ manifest_version: 3, name: "Shown", version: "1.0" });
const hidden = JSON.stringify({ manifest_version: 3, name: "Hidden", version: "1.0", host_permissions: ["<all_urls>"] });
const SYMLINK = 0o120777;
const FILE = 0o100644;

function signed(entries) {
  return buildCrx({ archive: zipList(entries), signers: [developer] });
}

test("a symlink manifest ahead of the real one is refused, so the prompt can't show a decoy", () => {
  rejects(() => packageFromCrx(signed([["manifest.json", shown, SYMLINK], ["manifest.json", hidden, FILE]])), "bad_zip");
});

test("an archive with two entries for the same file is refused", () => {
  rejects(() => packageFromCrx(signed([["manifest.json", shown], ["manifest.json", hidden]])), "bad_zip");
  rejects(() => packageFromCrx(signed([["manifest.json", shown], ["./manifest.json", hidden]])), "bad_zip");
  rejects(() => packageFromCrx(signed([["manifest.json", shown], ["Manifest.JSON", hidden]])), "bad_zip");
  rejects(() => packageFromCrx(signed([["manifest.json", shown], ["lib", "x"], ["lib/a.js", "y"]])), "bad_zip");
});

test("symlinks and other special files are refused anywhere in the archive, like Chrome's unzipper", () => {
  rejects(() => packageFromCrx(signed([["manifest.json", shown], ["link.js", "/etc/passwd", SYMLINK]])), "bad_zip");
  rejects(() => packageFromCrx(signed([["manifest.json", shown], ["fifo", "", 0o010644]])), "bad_zip");
});

test("unsafe paths anywhere in the archive are refused before the prompt", () => {
  for (const name of ["../evil.js", "/abs.js", "a/../../evil.js", "C:/evil.js", "a\\b.js"]) {
    rejects(() => packageFromCrx(signed([["manifest.json", shown], [name, "x"]])), "bad_zip");
  }
});

test("an unpacked extension keeps the manifest the user was shown", () => {
  const pkg = packageFromCrx(signed([["manifest.json", shown], ["lib/", ""], ["lib/a.js", "x"]]));
  const dir = unpackPackage(pkg);
  const unpacked = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(unpacked.name, "Shown");
  assert.equal(unpacked.key, developer.der.toString("base64"));

  const other = buildCrx({ archive: zipList([["manifest.json", hidden]]), signers: [keyPair()] });
  const swapped = { ...packageFromCrx(other), manifest: JSON.parse(shown) };
  assert.throws(() => unpackPackage(swapped), ManifestError);
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(dir)), swapped.id, "1.0_0")), false);
});

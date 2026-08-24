const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stubModule } = require("./stub-modules.js");

// cookies.ts pulls in electron's session, the store and the native keychain binding at module
// load. None of the functions under test go near any of them, so the doubles refuse loudly rather
// than pretend to work.
stubModule("electron", {
  app: {},
  net: {},
  session: { defaultSession: {}, fromPartition: () => ({}) },
});

// The specifier is the deep one on purpose: the keychain read is deliberately not on pixel-react's
// public index.
stubModule("pixel-react/dist/native", {
  chromiumSafeStorageSecret: () => {
    throw new Error("no test may reach the real keychain");
  },
});

stubModule("pixel-store", {
  DEFAULT_PROFILE: { slug: "default", name: "Default", createdAt: 0, builtIn: true },
  profileRegistry: () => [],
  matchProfiles: () => [],
  sortProfiles: (rows) => rows,
  setStoredProfiles: () => {},
  storedLastUsedProfile: () => null,
  setStoredLastUsedProfile: () => {},
  liveInstanceProfiles: () => [],
});

const {
  DARWIN_ITERATIONS,
  decryptCookieValue,
  deriveKey,
  importChromeCookies,
  matchesDomain,
  parseDomainFilters,
} = require("../dist/cookies.js");

/**
 * One recorded vector, not a round-trip through the code under test: AES-128-CBC, a 16-space IV and
 * PKCS#7, which is what Chromium writes. `KEY` is pbkdf2(secret "peanuts", salt "saltysalt", 1003
 * rounds, sha1, 16 bytes) - the published macOS shape. `WRONG_KEY` is the same KDF over a different
 * secret, chosen because its plaintext fails the pad check.
 */
const KEY = Buffer.from("d9a09d499b4e1b7461f28e67972c6dbd", "hex");
const WRONG_KEY = Buffer.from("4e7d8b7e6cac24c36ef2a982aad9b276", "hex");
const VALUE = "SID=abc123";

/** "SID=abc123" */
const BODY = "598bf689f5958dcef4c911ceee2b39fe";
/** sha256("github.com") + "SID=abc123", the Chrome 130+ layout */
const HOST_BOUND_BODY =
  "2725fc0dc9688af8204a39881d3cd12f9a839c903dfb529486dba6d0a4a2017951166db0b6b8e0a9308e68bdac05f29a";
/** exactly one block of plaintext, so the pad is a whole block of 0x10 */
const FULL_BLOCK_PAD_BODY = "e9537ee8b65377cd19a3e1dba379022509574fc625707c27278510f289b438b0";
/** decrypts to 0x41 * 15 then 0x05: the last byte claims five pad bytes that are not there */
const INCONSISTENT_PAD_BODY = "b6c6e375ef2eaa168f96347f020152fb";
/** decrypts to a trailing 0x00 */
const ZERO_PAD_BODY = "580ee86172891862481282cb151bb330";
/** decrypts to 0x11 * 16: a pad longer than the block */
const OVERLONG_PAD_BODY = "f4845daa1fee388a05511249b75d16db";

const row = (version, body) =>
  Buffer.concat([Buffer.from(version, "latin1"), Buffer.from(body, "hex")]);

test("the macOS key derivation matches the published vector", () => {
  assert.equal(DARWIN_ITERATIONS, 1003);
  assert.equal(deriveKey(Buffer.from("peanuts", "utf8"), DARWIN_ITERATIONS).toString("hex"), KEY.toString("hex"));
});

test("the iteration count is actually used", () => {
  // Chromium uses 1 round on Linux and 1003 on macOS, so a signature that took the count and
  // ignored it would derive the wrong key on one of the two platforms and look fine here.
  assert.equal(
    deriveKey(Buffer.from("peanuts", "utf8"), 1).toString("hex"),
    "fd621fe5a2b402539dfa147ca9272778",
  );
});

test("a v10 row decrypts with the v10 key", () => {
  assert.equal(decryptCookieValue(row("v10", BODY), { v10: KEY, v11: null }, "github.com"), VALUE);
});

test("the version prefix selects the key and never falls back to the other one", () => {
  // On Linux v10 means the hardcoded passphrase and v11 means the keyring secret. Decrypting one
  // with the other's key is the silent-garbage failure, so absence has to mean refusal.
  assert.equal(decryptCookieValue(row("v10", BODY), { v10: null, v11: KEY }, "github.com"), null);
  assert.equal(decryptCookieValue(row("v11", BODY), { v10: KEY, v11: null }, "github.com"), null);
  assert.equal(decryptCookieValue(row("v11", BODY), { v10: null, v11: KEY }, "github.com"), VALUE);
});

test("an unrecognised version prefix is refused", () => {
  for (const version of ["v09", "v12", "v20", "abc"]) {
    assert.equal(decryptCookieValue(row(version, BODY), { v10: KEY, v11: KEY }, "github.com"), null);
  }
});

test("the host hash Chrome 130+ prepends is stripped only for the matching host", () => {
  const keys = { v10: KEY, v11: null };
  assert.equal(decryptCookieValue(row("v10", HOST_BOUND_BODY), keys, "github.com"), VALUE);

  // Wrong host: the prefix is not ours to strip, so the value must not come back clean. A
  // hash-length blind trim would return VALUE here for any host at all.
  const mismatched = decryptCookieValue(row("v10", HOST_BOUND_BODY), keys, "gitlab.com");
  assert.notEqual(mismatched, VALUE);
  assert.ok(mismatched.endsWith(VALUE));
  assert.ok(mismatched.length > VALUE.length);
});

test("a plaintext that fills the last block round-trips", () => {
  assert.equal(
    decryptCookieValue(row("v10", FULL_BLOCK_PAD_BODY), { v10: KEY, v11: null }, "github.com"),
    "0123456789abcdef",
  );
});

test("a wrong key is refused rather than returning a truncated plaintext", () => {
  assert.equal(
    decryptCookieValue(row("v10", BODY), { v10: WRONG_KEY, v11: null }, "github.com"),
    null,
  );
});

test("every byte of the pad is checked, not just the last one", () => {
  const keys = { v10: KEY, v11: null };
  // Without a MAC the pad is the only signal the key or the ciphertext was wrong. Trusting the
  // last byte and slicing is the plausible bug, and it accepts all three of these.
  assert.equal(decryptCookieValue(row("v10", INCONSISTENT_PAD_BODY), keys, "github.com"), null);
  assert.equal(decryptCookieValue(row("v10", ZERO_PAD_BODY), keys, "github.com"), null);
  assert.equal(decryptCookieValue(row("v10", OVERLONG_PAD_BODY), keys, "github.com"), null);
});

test("a truncated or unaligned row is refused", () => {
  const keys = { v10: KEY, v11: KEY };
  assert.equal(decryptCookieValue(Buffer.from("v10", "latin1"), keys, "github.com"), null);
  assert.equal(decryptCookieValue(Buffer.alloc(0), keys, "github.com"), null);
  assert.equal(decryptCookieValue(row("v10", BODY.slice(0, 20)), keys, "github.com"), null);
});

test("a Uint8Array row is accepted, as sqlite hands it over", () => {
  const bytes = new Uint8Array(row("v10", BODY));
  assert.equal(decryptCookieValue(bytes, { v10: KEY, v11: null }, "github.com"), VALUE);
});

test("--domain accepts a list and normalises each entry", () => {
  assert.deepEqual(parseDomainFilters("github.com"), ["github.com"]);
  assert.deepEqual(parseDomainFilters("GitHub.COM"), ["github.com"]);
  assert.deepEqual(parseDomainFilters("*.github.com"), ["github.com"]);
  assert.deepEqual(parseDomainFilters(".github.com"), ["github.com"]);
  assert.deepEqual(parseDomainFilters("github.com, example.org; app.example.org"), [
    "github.com",
    "example.org",
    "app.example.org",
  ]);
  assert.deepEqual(parseDomainFilters("github.com github.com *.github.com"), ["github.com"]);
  assert.deepEqual(parseDomainFilters("localhost"), ["localhost"]);
});

test("a --domain value with no hostname in it is refused, never widened to everything", () => {
  // An empty filter list means "copy every cookie" downstream, so returning [] from a typo would
  // turn a narrow request into the whole jar. Each of these trims away to nothing.
  for (const raw of ["", "   ", ",", " , ; ", "*.", "..", "*. , ."]) {
    assert.throws(() => parseDomainFilters(raw), /no hostname/);
  }
});

test("a dotless --domain value is refused as a typo, and localhost is the exception", () => {
  assert.throws(() => parseDomainFilters("github"), /not a hostname/);
  assert.throws(() => parseDomainFilters("github.com internal"), /not a hostname/);
  assert.deepEqual(parseDomainFilters("localhost, github.com"), ["localhost", "github.com"]);
});

test("no filters matches every host", () => {
  assert.equal(matchesDomain("github.com", []), true);
  assert.equal(matchesDomain("", []), true);
});

test("a filter matches the host and its subdomains, on the label boundary only", () => {
  const filters = ["github.com"];
  assert.equal(matchesDomain("github.com", filters), true);
  assert.equal(matchesDomain("api.github.com", filters), true);
  assert.equal(matchesDomain(".github.com", filters), true);
  assert.equal(matchesDomain("GitHub.com", filters), true);

  // A bare endsWith would hand every cookie of notgithub.com to a --domain github.com import.
  assert.equal(matchesDomain("notgithub.com", filters), false);
  assert.equal(matchesDomain("github.com.evil.test", filters), false);
  assert.equal(matchesDomain("example.org", filters), false);
  assert.equal(matchesDomain("", filters), false);
  assert.equal(matchesDomain("   ", filters), false);
});

test("any one of several filters is enough", () => {
  const filters = ["github.com", "example.org"];
  assert.equal(matchesDomain("api.example.org", filters), true);
  assert.equal(matchesDomain("github.com", filters), true);
  assert.equal(matchesDomain("example.com", filters), false);
});

test("off macOS the import refuses before it can decrypt anything", async () => {
  // Faked rather than skipped: the interesting case is the one this machine is not. On Linux the
  // Safe Storage secret lives in gnome-keyring or kwallet and nothing here reads either, so
  // proceeding would write cookies decrypted with the wrong key.
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    await assert.rejects(importChromeCookies({}), (error) => {
      assert.match(error.message, /only the macOS keychain is implemented/);
      assert.match(error.message, /linux/);
      return true;
    });
  } finally {
    Object.defineProperty(process, "platform", real);
  }
});

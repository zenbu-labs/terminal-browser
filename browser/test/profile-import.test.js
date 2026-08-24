const assert = require("node:assert/strict");
const { test } = require("node:test");

const { cookieDetails, removeProfilePartition } = require("../dist/profile-import");

test("rejects path-like partition names before deletion", () => {
  assert.throws(() => removeProfilePartition("../../work"), /invalid profile partition/);
});

test("keeps host-only cookies host-only", () => {
  assert.deepEqual(
    cookieDetails({
      domain: "example.com",
      expires: 2_000_000_000,
      httpOnly: true,
      name: "__Host-session",
      path: "/",
      sameSite: "Strict",
      secure: true,
      session: false,
      value: "secret",
    }),
    {
      expirationDate: 2_000_000_000,
      httpOnly: true,
      name: "__Host-session",
      path: "/",
      sameSite: "strict",
      secure: true,
      url: "https://example.com/",
      value: "secret",
    },
  );
});

test("preserves domain cookies and maps SameSite=None", () => {
  const details = cookieDetails({
    domain: ".example.com",
    expires: 2_000_000_000,
    httpOnly: false,
    name: "session",
    path: "/account",
    sameSite: "None",
    secure: true,
    session: false,
    value: "secret",
  });
  assert.equal(details.domain, ".example.com");
  assert.equal(details.sameSite, "no_restriction");
  assert.equal(details.url, "https://example.com/account");
});

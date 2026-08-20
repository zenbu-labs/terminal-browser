const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  findProfile,
  listProfiles,
  profileSettings,
  removeProfile,
  saveProfile,
  setDefaultProfile,
  setDefaultSource,
} = require("../dist/profiles");

test("saves, updates, lists, and removes profile records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-profiles-test-"));
  const file = path.join(directory, "profiles.json");
  try {
    assert.deepEqual(listProfiles(file), []);
    saveProfile({ createdAt: "2026-01-01T00:00:00.000Z", name: "work" }, file);
    saveProfile({ createdAt: "2026-01-01T00:00:00.000Z", name: "clean" }, file);
    assert.deepEqual(listProfiles(file).map((profile) => profile.name), ["clean", "work"]);

    const work = findProfile("work", file);
    saveProfile({ ...work, lastSyncedAt: "2026-01-02T00:00:00.000Z" }, file);
    assert.equal(findProfile("work", file).lastSyncedAt, "2026-01-02T00:00:00.000Z");
    assert.equal(removeProfile("work", file), true);
    assert.equal(removeProfile("work", file), false);
    assert.equal(findProfile("work", file), null);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("stores profile defaults and protects the selected profile", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-profiles-test-"));
  const file = path.join(directory, "profiles.json");
  const source = {
    browser: "brave",
    browserPath: "/usr/bin/brave",
    sourceDir: "/profiles/brave",
    sourceProfile: "Default",
  };
  try {
    assert.deepEqual(profileSettings(file), { defaultProfile: null, defaultSource: null });
    saveProfile({ createdAt: "2026-01-01T00:00:00.000Z", name: "work" }, file);
    setDefaultProfile("work", file);
    setDefaultSource(source, file);
    assert.deepEqual(profileSettings(file), { defaultProfile: "work", defaultSource: source });
    assert.throws(() => removeProfile("work", file), /select another default/);
    setDefaultProfile(null, file);
    setDefaultSource(null, file);
    assert.equal(removeProfile("work", file), true);
    assert.deepEqual(profileSettings(file), { defaultProfile: null, defaultSource: null });
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("refuses to overwrite an invalid profile registry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-profiles-test-"));
  const file = path.join(directory, "profiles.json");
  try {
    fs.writeFileSync(file, "not json\n");
    assert.throws(() => listProfiles(file), /invalid profile registry/);
    assert.throws(
      () => saveProfile({ createdAt: "2026-01-01T00:00:00.000Z", name: "work" }, file),
      /invalid profile registry/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "not json\n");
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

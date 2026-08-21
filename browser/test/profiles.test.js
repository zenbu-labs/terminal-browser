const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

/**
 * profiles.ts reaches the sqlite app-state store and electron's session. Both are replaced with
 * in-memory doubles, which is what lets the delete path run against a storage wipe that fails.
 */
const state = { profiles: [], lastUsed: null, panes: [] };

/** Every partition a wipe was asked for, and what the next wipe does. */
const wipes = [];
let onWipe = async () => {};

function wipeTarget(partition) {
  return {
    clearData: () => {
      wipes.push(partition);
      return onWipe();
    },
  };
}

const stubs = {
  "pixel-store": {
    storedProfiles: () => state.profiles.map((row) => ({ ...row })),
    setStoredProfiles: (rows) => {
      state.profiles = rows.map((row) => ({ ...row }));
    },
    storedLastUsedProfile: () => state.lastUsed,
    setStoredLastUsedProfile: (slug) => {
      state.lastUsed = slug;
    },
    liveInstanceProfiles: () => state.panes,
  },
  electron: {
    app: {},
    net: {},
    session: {
      defaultSession: wipeTarget(null),
      fromPartition: (partition) => wipeTarget(partition),
    },
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};

const { createProfile, deleteProfile, listProfiles } = require("../dist/profiles.js");

/** The module caches the list for the process, so these tests share one and run in order. */
const slugs = () => listProfiles().map((profile) => profile.slug);

test("the default profile is refused without touching any storage", async () => {
  wipes.length = 0;
  await assert.rejects(deleteProfile("default"), /cannot be deleted/);
  assert.deepEqual(wipes, []);
});

test("a failed wipe leaves the profile on the list and surfaces the failure", async () => {
  wipes.length = 0;
  assert.equal(createProfile("Work").slug, "work");
  state.lastUsed = "work";

  onWipe = async () => {
    throw new Error("clearData failed");
  };
  await assert.rejects(deleteProfile("work"), /clearData failed/);

  assert.deepEqual(wipes, ["persist:profile-work"]);
  assert.deepEqual(slugs(), ["default", "work"]);
  assert.deepEqual(
    state.profiles.map((row) => row.slug),
    ["work"],
  );
  assert.equal(state.lastUsed, "work");
});

test("storage a failed delete kept is not handed to the next profile of that name", () => {
  // The slug is the storage key, so a re-minted "work" would sign the new profile into the old
  // one's cookies - which is exactly what the un-listed-but-not-wiped state used to allow.
  assert.equal(createProfile("Work").slug, "work-2");
});

test("a successful wipe lands before the profile is forgotten", async () => {
  wipes.length = 0;
  let listedMidWipe = null;
  onWipe = async () => {
    listedMidWipe = slugs();
  };
  await deleteProfile("work");

  assert.deepEqual(wipes, ["persist:profile-work"]);
  assert.ok(listedMidWipe.includes("work"));
  assert.deepEqual(slugs(), ["default", "work-2"]);
  assert.deepEqual(
    state.profiles.map((row) => row.slug),
    ["work-2"],
  );
  assert.equal(state.lastUsed, "default");
});

test("a pane on the profile blocks the delete before anything is wiped", async () => {
  wipes.length = 0;
  state.panes = [{ tty: "/dev/ttys004", profile: "work-2" }];
  await assert.rejects(deleteProfile("work-2"), /while 1 pane\(s\) are using it/);
  assert.deepEqual(wipes, []);
  assert.deepEqual(slugs(), ["default", "work-2"]);
  state.panes = [];
});

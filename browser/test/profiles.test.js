const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stubModule } = require("./stub-modules.js");

/**
 * profiles.ts reaches the sqlite app-state store and electron's session. Both are replaced with
 * in-memory doubles, which is what lets the delete path run against a storage wipe that fails.
 * The store's pure helpers come from the real module by path, so the selector matching a refusal
 * depends on is the shipped one and not a copy that could drift from it.
 */
const { DEFAULT_PROFILE, matchProfiles, sortProfiles } = require("pixel-store/dist/app-state.js");

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

stubModule("pixel-store", {
  DEFAULT_PROFILE,
  matchProfiles,
  sortProfiles,
  profileRegistry: () =>
    sortProfiles([
      DEFAULT_PROFILE,
      ...state.profiles
        .filter((row) => row.slug !== DEFAULT_PROFILE.slug)
        .map((row) => ({ ...row, builtIn: false })),
    ]),
  setStoredProfiles: (rows) => {
    state.profiles = rows.map((row) => ({ ...row }));
  },
  storedLastUsedProfile: () => state.lastUsed,
  setStoredLastUsedProfile: (slug) => {
    state.lastUsed = slug;
  },
  liveInstanceProfiles: () => state.panes,
});

stubModule("electron", {
  app: {},
  net: {},
  session: {
    defaultSession: wipeTarget(null),
    fromPartition: (partition) => wipeTarget(partition),
  },
});

const {
  createProfile,
  deleteProfile,
  listProfiles,
  profileForNewPane,
} = require("../dist/profiles.js");

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

test("a mistyped --profile is refused instead of landing on the last-used identity", () => {
  // The old behaviour returned lastUsedProfile(), so a typo opened a pane signed in as somebody.
  // Point last-used at a real profile: if the refusal ever regresses, this returns "work-2".
  state.lastUsed = "work-2";
  assert.throws(() => profileForNewPane("wrok", null), /wrok/);
});

test("an ambiguous display name is refused and names the profiles it could not choose between", () => {
  // A name with a space is not also a slug, which is what lets two profiles collide on it -
  // createProfile allows duplicate names and only the slug is minted unique.
  assert.equal(createProfile("Side Project").slug, "side-project");
  assert.equal(createProfile("Side Project").slug, "side-project-2");

  assert.throws(
    () => profileForNewPane("Side Project", null),
    (error) => {
      // Both slugs, listed in full: naming only one is no better than picking one.
      const listed = error.message.split(": ").pop().split(", ").sort();
      assert.deepEqual(listed, ["side-project", "side-project-2"]);
      return true;
    },
  );
  // The slug is unambiguous even when the display name is not.
  assert.equal(profileForNewPane("side-project-2", null).slug, "side-project-2");
});

test("a refused --profile is refused before the parent pane can supply one", () => {
  state.panes = [{ tty: "/dev/ttys009", profile: "work-2" }];
  assert.throws(() => profileForNewPane("wrok", "/dev/ttys009"), /wrok/);
  state.panes = [];
});

test("with nothing asked for, the parent pane wins over the last-used profile", () => {
  state.lastUsed = "side-project";
  state.panes = [{ tty: "/dev/ttys009", profile: "work-2" }];
  assert.equal(profileForNewPane(null, "/dev/ttys009").slug, "work-2");
  assert.equal(profileForNewPane(null, "/dev/ttys999").slug, "side-project");
  assert.equal(profileForNewPane(null, null).slug, "side-project");
  state.panes = [];
});

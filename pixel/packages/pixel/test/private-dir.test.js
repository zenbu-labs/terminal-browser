const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");

const { UnsafeDirectoryError, ancestorProblem, ensureOwnedDir, ensurePrivateDir, privateDirProblem, reclaimPrivateDir } = require("../dist/private-dir.js");

const uid = process.getuid();
const dir = (stat) => ({ isDirectory: () => true, ...stat });

function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tb-private-")));
  t.after(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const ACL_TOOL = process.platform === "darwin" || spawnSync("setfacl", ["--version"]).status === 0;

// "everyone" on macOS and the user nobody on Linux stand in for another user.
function allowOthers(target, rights) {
  if (process.platform === "darwin") {
    const perms = {
      read: "read,list,search",
      write: "list,search,add_file,delete_child",
      inherited: "read,write,list,search,add_file,delete_child,file_inherit,directory_inherit,only_inherit",
    }[rights];
    execFileSync("chmod", ["+a", `everyone allow ${perms}`, target]);
  } else {
    const spec = rights === "inherited" ? ["-d", "-m", "u:nobody:rwx"] : ["-m", rights === "read" ? "u:nobody:rx" : "u:nobody:rwx"];
    execFileSync("setfacl", [...spec, target]);
  }
}

function hasAcl(target) {
  if (process.platform === "darwin") return /^ *\d+: /m.test(execFileSync("ls", ["-led", target], { encoding: "utf8" }));
  return /^(default:|(user|group):[^:])/m.test(execFileSync("getfacl", ["-cp", target], { encoding: "utf8" }));
}

function withUmask(mask, run) {
  const previous = process.umask(mask);
  try {
    return run();
  } finally {
    process.umask(previous);
  }
}

test("a permissive umask still gives a 0700 directory, parents included", (t) => {
  const root = scratch(t);
  const target = path.join(root, "state", "app");
  withUmask(0o000, () => ensurePrivateDir(target));
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
});

test("an existing directory of ours is tightened to 0700, unless others could already write to it", (t) => {
  const root = scratch(t);
  const readable = path.join(root, "readable");
  fs.mkdirSync(readable, { mode: 0o755 });
  fs.chmodSync(readable, 0o755);
  ensurePrivateDir(readable);
  assert.equal(fs.statSync(readable).mode & 0o777, 0o700);
  const writable = path.join(root, "writable");
  fs.mkdirSync(writable);
  fs.chmodSync(writable, 0o777);
  assert.throws(() => ensurePrivateDir(writable), UnsafeDirectoryError);
  assert.equal(fs.statSync(writable).mode & 0o777, 0o777);
});

test("a symlink, a file, or a parent others can write to is refused", (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, "real"));
  fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
  assert.throws(() => ensurePrivateDir(path.join(root, "link")), UnsafeDirectoryError);
  fs.writeFileSync(path.join(root, "file"), "");
  assert.throws(() => ensurePrivateDir(path.join(root, "file")), UnsafeDirectoryError);
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  assert.throws(() => ensurePrivateDir(path.join(shared, "app")), UnsafeDirectoryError);
  assert.equal(fs.existsSync(path.join(shared, "app")), false);
  fs.chmodSync(shared, 0o1777);
  ensurePrivateDir(path.join(shared, "app"));
  assert.equal(fs.statSync(path.join(shared, "app")).mode & 0o777, 0o700);
});

test("directories owned by another user are refused, on the way and at the end", (t) => {
  const other = uid + 1;
  const shared = () => false;
  assert.equal(ancestorProblem({ uid, gid: 1, mode: 0o40755 }, uid, shared), null);
  assert.equal(ancestorProblem({ uid: 0, gid: 1, mode: 0o40755 }, uid, shared), null);
  assert.equal(ancestorProblem({ uid: 0, gid: 1, mode: 0o41777 }, uid, shared), null);
  assert.notEqual(ancestorProblem({ uid: other, gid: 1, mode: 0o40755 }, uid, shared), null);
  assert.notEqual(ancestorProblem({ uid, gid: 1, mode: 0o40775 }, uid, shared), null);
  assert.notEqual(ancestorProblem({ uid: 0, gid: 1, mode: 0o40777 }, uid, shared), null);
  assert.equal(privateDirProblem(dir({ uid, gid: 1, mode: 0o40700 }), uid, shared), null);
  assert.notEqual(privateDirProblem(dir({ uid: other, gid: 1, mode: 0o40700 }), uid, shared), null);
  assert.notEqual(privateDirProblem(dir({ uid: 0, gid: 1, mode: 0o40700 }), uid, shared), null);
  assert.notEqual(privateDirProblem(dir({ uid, gid: 1, mode: 0o40770 }), uid, shared), null);
  assert.notEqual(privateDirProblem({ uid, gid: 1, mode: 0o100600, isDirectory: () => false }, uid, shared), null);
  const ours = path.join(scratch(t), "ours");
  fs.mkdirSync(ours);
  assert.throws(() => ensurePrivateDir(ours, other), UnsafeDirectoryError);
});

test("a parent its owner's private group can write to is accepted; one a shared group or everyone can write to is refused", (t) => {
  const ownGroup = (gid, user) => gid === 4242 && user === uid;
  assert.equal(ancestorProblem({ uid, gid: 4242, mode: 0o40775 }, uid, ownGroup), null);
  assert.notEqual(ancestorProblem({ uid, gid: 4243, mode: 0o40775 }, uid, ownGroup), null);
  assert.notEqual(ancestorProblem({ uid, gid: 4242, mode: 0o40777 }, uid, ownGroup), null);
  assert.equal(privateDirProblem(dir({ uid, gid: 4242, mode: 0o40770 }), uid, ownGroup), null);
  const root = scratch(t);
  const share = path.join(root, "share");
  fs.mkdirSync(share);
  fs.chmodSync(share, 0o775);
  assert.throws(() => ensurePrivateDir(path.join(share, "app"), uid, () => false), /other users can write to it/);
  assert.equal(fs.existsSync(path.join(share, "app")), false);
  ensurePrivateDir(path.join(share, "app"), uid, (gid) => gid === fs.statSync(share).gid);
  assert.equal(fs.statSync(path.join(share, "app")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(share).mode & 0o777, 0o775);
});

test("a group counts as private only when its one member is the user", () => {
  const { groupIsPrivateTo } = require("../dist/react/native.js");
  if (uid !== 0) assert.equal(groupIsPrivateTo(0, uid), false);
  assert.equal(groupIsPrivateTo(2 ** 31 - 7, uid), false);
});

test("a symlink on the way is only followed out of a folder nobody else can write to", (t) => {
  const root = scratch(t);
  const real = path.join(root, "real");
  fs.mkdirSync(real, { mode: 0o755 });
  fs.symlinkSync(real, path.join(root, "link"));
  ensurePrivateDir(path.join(root, "link", "app"));
  assert.equal(fs.lstatSync(path.join(real, "app")).isDirectory(), true);
  const open = path.join(root, "open");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  fs.symlinkSync("../real", path.join(open, "link"));
  assert.throws(() => ensurePrivateDir(path.join(open, "link", "other")), /other users can write to it/);
  assert.equal(fs.existsSync(path.join(real, "other")), false);
  fs.mkdirSync(path.join(open, "inner"), { mode: 0o700 });
  fs.symlinkSync(path.join(open, "inner"), path.join(root, "through"));
  assert.throws(() => ensurePrivateDir(path.join(root, "through", "app")), /other users can write to it/);
  assert.equal(fs.existsSync(path.join(open, "inner", "app")), false);
});

test("a symlink on the way that another user owns is refused, even in a sticky folder; root's are followed", { skip: uid === 0 }, (t) => {
  const tmp = fs.realpathSync("/tmp");
  assert.equal(fs.statSync(tmp).uid, 0);
  const target = fs.mkdtempSync(path.join(tmp, "tb-target-"));
  const link = path.join(tmp, `tb-planted-${process.pid}`);
  fs.symlinkSync(target, link);
  t.after(() => {
    fs.unlinkSync(link);
    fs.rmSync(target, { recursive: true, force: true });
  });
  // Checked as root, so the link we made here is the one another user planted.
  const throughLinks = path.join("/tmp", path.basename(link), "app");
  assert.throws(
    () => ensurePrivateDir(throughLinks, 0),
    (error) => error instanceof UnsafeDirectoryError && error.message === `Refusing to use ${link}: it is a symbolic link owned by another user`,
  );
  assert.deepEqual(fs.readdirSync(target), []);
});

test("a directory an ACL lets other users write to is refused, and taken back by reclaimPrivateDir", { skip: !ACL_TOOL }, (t) => {
  const root = scratch(t);
  const open = path.join(root, "open");
  fs.mkdirSync(open, { mode: 0o700 });
  allowOthers(open, "write");
  assert.throws(() => ensurePrivateDir(open), /other users can write to it/);
  assert.equal(hasAcl(open), true);
  reclaimPrivateDir(open);
  assert.equal(hasAcl(open), false);
  assert.equal(fs.statSync(open).mode & 0o777, 0o700);
  const readable = path.join(root, "readable");
  fs.mkdirSync(readable, { mode: 0o700 });
  allowOthers(readable, "read");
  ensurePrivateDir(readable);
  assert.equal(hasAcl(readable), false);
});

test("a parent an ACL lets other users write to is refused, and ACLs a new folder inherits are dropped", { skip: !ACL_TOOL }, (t) => {
  const root = scratch(t);
  const parent = path.join(root, "parent");
  fs.mkdirSync(parent, { mode: 0o755 });
  allowOthers(parent, "write");
  assert.throws(() => ensurePrivateDir(path.join(parent, "app")), /other users can write to it/);
  assert.deepEqual(fs.readdirSync(parent), []);
  const inheriting = path.join(root, "inheriting");
  fs.mkdirSync(inheriting, { mode: 0o755 });
  allowOthers(inheriting, "inherited");
  fs.mkdirSync(path.join(inheriting, "plain"));
  assert.equal(hasAcl(path.join(inheriting, "plain")), true);
  ensureOwnedDir(path.join(inheriting, "owned", "app"));
  assert.equal(hasAcl(path.join(inheriting, "owned")), false);
  assert.equal(hasAcl(path.join(inheriting, "owned", "app")), false);
  ensureOwnedDir(path.join(inheriting, "plain"));
  assert.equal(hasAcl(path.join(inheriting, "plain")), false);
});

test("ensureOwnedDir makes a 0700 folder under a permissive umask and takes back a loose one of ours below a shared parent", (t) => {
  const root = scratch(t);
  const fresh = path.join(root, "share", "app");
  withUmask(0o000, () => ensureOwnedDir(fresh));
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(fresh)).mode & 0o777, 0o700);
  const shared = path.join(root, "group");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o775);
  const loose = path.join(shared, "app");
  fs.mkdirSync(loose);
  fs.chmodSync(loose, 0o775);
  ensureOwnedDir(loose);
  assert.equal(fs.statSync(loose).mode & 0o777, 0o700);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o775);
});

test("ensureOwnedDir refuses a symbolic link, a file, or someone else's folder, and changes none of them", (t) => {
  const root = scratch(t);
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  fs.chmodSync(target, 0o755);
  fs.symlinkSync(target, path.join(root, "link"));
  assert.throws(() => ensureOwnedDir(path.join(root, "link")), /it is a symbolic link/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  fs.writeFileSync(path.join(root, "file"), "");
  assert.throws(() => ensureOwnedDir(path.join(root, "file")), /it is not a directory/);
  assert.throws(() => ensureOwnedDir(target, uid + 1), /owned by another user/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});

test("instance records are 0600 in a 0700 folder under a permissive umask", (t) => {
  const { InstanceRecord } = require("../dist/instances.js");
  const root = scratch(t);
  const env = { XDG_STATE_HOME: path.join(root, "state") };
  const instance = { tty: "/dev/ttys999", pid: process.pid, socket: "/tmp/none.sock", protocol: 1, name: "test", title: "secret", cwd: root, startedAt: 0 };
  const record = withUmask(0o000, () => new InstanceRecord(instance, env));
  withUmask(0o000, () => record.setTitle("another"));
  const dir = path.join(root, "state", "pixel", "instances");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "_dev_ttys999.json")).mode & 0o777, 0o600);
});

test("the real path is returned, so swapping a link on the way afterwards changes nothing", (t) => {
  const root = scratch(t);
  const safe = path.join(root, "safe");
  const decoy = path.join(root, "decoy");
  fs.mkdirSync(safe, { mode: 0o700 });
  fs.mkdirSync(decoy, { mode: 0o700 });
  fs.symlinkSync(safe, path.join(root, "alias"));
  const real = ensurePrivateDir(path.join(root, "alias", "app"));
  assert.equal(real, path.join(safe, "app"));
  fs.unlinkSync(path.join(root, "alias"));
  fs.symlinkSync(decoy, path.join(root, "alias"));
  fs.writeFileSync(path.join(real, "probe"), "");
  assert.equal(fs.existsSync(path.join(safe, "app", "probe")), true);
  assert.equal(fs.existsSync(path.join(decoy, "app")), false);
});

test("under umask 002 every directory created on the way is 0700", (t) => {
  const root = scratch(t);
  const target = path.join(root, "local", "state", "app", "cdp");
  withUmask(0o002, () => ensurePrivateDir(target));
  for (let dir = target; dir !== root; dir = path.dirname(dir)) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
});

test("a group is private only when it is the user's own same-named primary group", () => {
  const { groupIsPrivateTo } = require("../dist/react/native.js");
  const user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
  const group = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
  assert.equal(groupIsPrivateTo(process.getgid(), uid), user === group);
  assert.equal(groupIsPrivateTo(process.getgid(), uid + 1), false);
});

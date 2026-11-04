import fs from "node:fs";
import path from "node:path";

import { aclGrantsOthers, clearAcl, groupIsPrivateTo, openDirectoryAt, readLinkAt } from "./react/native";

export interface Ownership {
  uid: number;
  gid: number;
  mode: number;
}

export type GroupCheck = (gid: number, uid: number) => boolean;

const STICKY = 0o1000;
const MAX_LINKS = 40;

export function ownUid(): number {
  return process.getuid?.() ?? 0;
}

// Group write access counts as ours alone when the group has no other member,
// like the group of the same name Debian and Ubuntu make for each user.
function othersCanWrite(stat: Ownership, uid: number, privateGroup: GroupCheck): boolean {
  if ((stat.mode & 0o002) !== 0) return true;
  return (stat.mode & 0o020) !== 0 && !privateGroup(stat.gid, uid);
}

// A directory above a private one is safe when nobody else can rename or
// replace what is inside it: owned by us or root, and only writable by others
// when the sticky bit stops them from touching entries they don't own.
export function ancestorProblem(stat: Ownership, uid: number, privateGroup: GroupCheck = groupIsPrivateTo): string | null {
  // fixme: placeholder copy
  if (stat.uid !== uid && stat.uid !== 0) return "it is owned by another user";
  // fixme: placeholder copy
  if ((stat.mode & STICKY) === 0 && othersCanWrite(stat, uid, privateGroup)) return "other users can write to it";
  return null;
}

export function privateDirProblem(
  stat: Ownership & { isDirectory(): boolean },
  uid: number,
  privateGroup: GroupCheck = groupIsPrivateTo,
): string | null {
  const problem = ownedDirProblem(stat, uid);
  if (problem) return problem;
  // fixme: placeholder copy
  if (othersCanWrite(stat, uid, privateGroup)) return "other users can write to it";
  return null;
}

function ownedDirProblem(stat: Ownership & { isDirectory(): boolean }, uid: number): string | null {
  // fixme: placeholder copy
  if (!stat.isDirectory()) return "it is not a directory";
  // fixme: placeholder copy
  if (stat.uid !== uid) return "it is owned by another user";
  return null;
}

// An access control list can let other users in whatever the mode bits say.
function aclProblem(fd: number, uid: number): string | null {
  // fixme: placeholder copy
  return aclGrantsOthers(fd, uid) === "write" ? "other users can write to it" : null;
}

// Leaves `fd` open to its owner alone: no ACL entries, inherited ones included,
// and only the owner's bits of `mode`.
export function restrictToOwner(fd: number, mode: number): void {
  clearAcl(fd);
  fs.fchmodSync(fd, mode);
}

export class UnsafeDirectoryError extends Error {
  constructor(dir: string, problem: string) {
    // fixme: placeholder copy
    super(`Refusing to use ${dir}: ${problem}`);
  }
}

const OPEN_DIRECTORY = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const OPEN_ROOT = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

// Walks to `dir` from / one directory descriptor at a time, so every folder that
// is checked is the folder the next name is looked up in, and a symlink on the
// way is only followed out of a folder already checked. Missing folders are made
// 0700, and `dir` itself must be ours and is made 0700. Returns its descriptor
// and its real path.
function openPrivateDir(
  dir: string,
  uid: number,
  privateGroup: GroupCheck,
  reclaim: boolean,
): { fd: number; real: string } {
  const pending = path.resolve(dir).split(path.sep).filter(Boolean);
  const above: number[] = [];
  let current = fs.openSync(path.sep, OPEN_ROOT);
  let at: string = path.sep;
  let links = 0;
  const verify = (where: string, problem: string | null) => {
    if (problem) throw new UnsafeDirectoryError(where, problem);
  };
  try {
    const root = fs.fstatSync(current);
    verify(at, pending.length === 0 ? privateDirProblem(root, uid, privateGroup) : ancestorProblem(root, uid, privateGroup));
    verify(at, aclProblem(current, uid));
    while (pending.length > 0) {
      const name = pending.shift()!;
      if (name === ".") continue;
      if (name === "..") {
        if (above.length > 0) {
          fs.closeSync(current);
          current = above.pop()!;
          at = path.dirname(at);
        }
        continue;
      }
      const last = pending.length === 0;
      const where = path.join(at, name);
      let next: number;
      let created = false;
      try {
        next = openDirectoryAt(current, name, false);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") {
          next = openDirectoryAt(current, name, true);
          created = true;
        } else if (code === "ELOOP" || code === "ENOTDIR") {
          const link = readLinkAt(current, name);
          // fixme: placeholder copy
          if (link === null) throw new UnsafeDirectoryError(where, "it is not a directory");
          // fixme: placeholder copy
          if (last || ++links > MAX_LINKS) throw new UnsafeDirectoryError(where, "it is a symbolic link");
          // Anyone can plant a link in a sticky folder like /tmp and re-point it
          // after we've looked, so only links of ours or root's are followed.
          // fixme: placeholder copy
          if (link.owner !== uid && link.owner !== 0) throw new UnsafeDirectoryError(where, "it is a symbolic link owned by another user");
          pending.unshift(...link.target.split(path.sep).filter(Boolean));
          if (path.isAbsolute(link.target)) {
            for (const fd of above.splice(0)) fs.closeSync(fd);
            fs.closeSync(current);
            current = fs.openSync(path.sep, OPEN_ROOT);
            at = path.sep;
          }
          continue;
        } else {
          throw error;
        }
      }
      above.push(current);
      current = next;
      at = where;
      const stat = fs.fstatSync(current);
      if (last || created) {
        verify(where, reclaim && !created ? ownedDirProblem(stat, uid) : privateDirProblem(stat, uid, privateGroup));
        if (!reclaim && !created) verify(where, aclProblem(current, uid));
        restrictToOwner(current, 0o700);
      } else {
        verify(where, ancestorProblem(stat, uid, privateGroup));
        verify(where, aclProblem(current, uid));
      }
    }
    return { fd: current, real: at };
  } catch (error) {
    fs.closeSync(current);
    throw error;
  } finally {
    for (const fd of above) fs.closeSync(fd);
  }
}

function openAndClose(dir: string, uid: number, privateGroup: GroupCheck, reclaim: boolean): string {
  const { fd, real } = openPrivateDir(dir, uid, privateGroup, reclaim);
  fs.closeSync(fd);
  return real;
}

// Creates `dir` (and missing parents) readable only by us, and refuses a
// directory that another user owns or could swap out from under us. Returns
// its real path, which callers must use from then on instead of `dir`.
export function ensurePrivateDir(dir: string, uid = ownUid(), privateGroup: GroupCheck = groupIsPrivateTo): string {
  return openAndClose(dir, uid, privateGroup, false);
}

// Like ensurePrivateDir, but an existing folder of ours that others could write
// to is taken back (made 0700) instead of refused.
export function reclaimPrivateDir(dir: string, uid = ownUid(), privateGroup: GroupCheck = groupIsPrivateTo): string {
  return openAndClose(dir, uid, privateGroup, true);
}

// Creates `dir` (and missing parents) readable only by us, and takes back an
// existing one of ours. Unlike ensurePrivateDir it trusts the folders above it:
// it keeps what is inside unreadable, and isn't relied on to stop tampering.
export function ensureOwnedDir(dir: string, uid = ownUid()): void {
  const parent = path.dirname(dir);
  if (parent !== dir && !fs.existsSync(parent)) ensureOwnedDir(parent, uid);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  tightenOwnedDir(dir, uid);
}

export function tightenOwnedDir(dir: string, uid = ownUid()): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, OPEN_DIRECTORY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // fixme: placeholder copy
    if (code === "ELOOP" || (code === "ENOTDIR" && fs.lstatSync(dir).isSymbolicLink())) throw new UnsafeDirectoryError(dir, "it is a symbolic link");
    // fixme: placeholder copy
    if (code === "ENOTDIR") throw new UnsafeDirectoryError(dir, "it is not a directory");
    throw error;
  }
  try {
    // fixme: placeholder copy
    if (fs.fstatSync(fd).uid !== uid) throw new UnsafeDirectoryError(dir, "it is owned by another user");
    restrictToOwner(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

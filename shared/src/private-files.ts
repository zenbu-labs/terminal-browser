import fs from "node:fs";
import path from "node:path";

import { ownUid, restrictToOwner } from "@zenbu-labs/pixel/private-dir";

const { O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = fs.constants;

export class UnsafeFileError extends Error {
  constructor(file: string, problem: string) {
    // fixme: placeholder copy
    super(`Refusing to use ${file}: ${problem}`);
  }
}

function claimFile(file: string, flags: number, uid: number): number {
  const refuse = (problem: string) => new UnsafeFileError(file, problem);
  let fd: number;
  try {
    fd = fs.openSync(file, flags | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch (error) {
    // fixme: placeholder copy
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw refuse("it is a symbolic link");
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    // fixme: placeholder copy
    if (!stat.isFile()) throw refuse("it is not a regular file");
    // fixme: placeholder copy
    if (stat.uid !== uid) throw refuse("it is owned by another user");
    restrictToOwner(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function ensurePrivateFile(file: string, uid = ownUid()): void {
  fs.closeSync(claimFile(file, O_RDONLY | O_CREAT, uid));
}

export function tightenPrivateFile(file: string, uid = ownUid()): void {
  let fd: number;
  try {
    fd = claimFile(file, O_RDONLY, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.closeSync(fd);
}

export function createPrivateFile(file: string, data: string | Uint8Array, uid = ownUid()): void {
  const fd = claimFile(file, O_WRONLY | O_CREAT | O_EXCL, uid);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export function writePrivateFile(file: string, data: string | Uint8Array, uid = ownUid()): void {
  const fd = claimFile(file, O_WRONLY | O_CREAT, uid);
  try {
    fs.ftruncateSync(fd);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export function replacePrivateFile(file: string, data: string | Uint8Array, uid = ownUid()): void {
  const temporary = `${file}.tmp`;
  fs.rmSync(temporary, { force: true });
  createPrivateFile(temporary, data, uid);
  fs.renameSync(temporary, file);
}

export function openPrivateLog(file: string, uid = ownUid()): number {
  return claimFile(file, O_WRONLY | O_CREAT | O_APPEND, uid);
}

export function appendPrivateFile(file: string, data: string, uid = ownUid()): void {
  const fd = openPrivateLog(file, uid);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export function tightenPrivateFiles(dir: string, keep: (name: string) => boolean = () => true, uid = ownUid()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!keep(name)) continue;
    const file = path.join(dir, name);
    if (fs.lstatSync(file).isDirectory()) continue;
    tightenPrivateFile(file, uid);
  }
}

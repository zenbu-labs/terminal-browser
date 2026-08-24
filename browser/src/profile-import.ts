import fs from "node:fs";
import path from "node:path";

import { app, session } from "electron";
import type { CookiesSetDetails } from "electron";

import { persistentPartition } from "./page/browser-session";

interface ImportedCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  partitionKey?: { topLevelSite?: string };
  path: string;
  sameSite?: "Strict" | "Lax" | "None";
  secure: boolean;
  session: boolean;
  value: string;
}

export interface ProfileImportResult {
  imported: number;
  skippedInvalid: number;
  skippedPartitioned: number;
  skippedSession: number;
}

export function removeProfilePartition(partition: string): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(partition)) {
    throw new Error("invalid profile partition");
  }
  const directory = path.join(app.getPath("userData"), "Partitions", partition);
  const existed = fs.existsSync(directory);
  fs.rmSync(directory, { force: true, recursive: true });
  return existed;
}

export async function importProfileCookies(
  file: string,
  partition: string,
  replace: boolean,
): Promise<ProfileImportResult> {
  const cookies = JSON.parse(fs.readFileSync(file, "utf8")) as ImportedCookie[];
  const target = session.fromPartition(persistentPartition(partition));
  if (replace) await target.clearStorageData({ storages: ["cookies"] });
  const result: ProfileImportResult = {
    imported: 0,
    skippedInvalid: 0,
    skippedPartitioned: 0,
    skippedSession: 0,
  };
  for (const cookie of cookies) {
    if (cookie.partitionKey?.topLevelSite) {
      result.skippedPartitioned++;
      continue;
    }
    if (cookie.session || cookie.expires <= 0) {
      result.skippedSession++;
      continue;
    }
    try {
      await target.cookies.set(cookieDetails(cookie));
      result.imported++;
    } catch {
      result.skippedInvalid++;
    }
  }
  await target.flushStorageData();
  return result;
}

export function cookieDetails(cookie: ImportedCookie): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  const pathname = cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`;
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${pathname}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expires,
    sameSite: sameSite(cookie.sameSite),
  };
}

function sameSite(value: ImportedCookie["sameSite"]): CookiesSetDetails["sameSite"] {
  if (value === "Strict") return "strict";
  if (value === "Lax") return "lax";
  if (value === "None") return "no_restriction";
  return "unspecified";
}

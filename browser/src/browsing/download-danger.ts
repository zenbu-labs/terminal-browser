import path from "node:path";

import type { DownloadDanger } from "shared";

import { FILE_TYPES } from "./download-file-types";

export type DangerLevel = "safe" | "gesture" | "dangerous";
// Chromium's DownloadFileType.PlatformSettings: how risky the type is, and
// whether Chrome would ever open it automatically.
export type FileTypeSettings = readonly [danger: DangerLevel, autoOpen: boolean];
export type Platform = "mac" | "linux";

const DEFAULT_SETTINGS: FileTypeSettings = ["safe", true];

export function currentPlatform(): Platform {
  return process.platform === "darwin" ? "mac" : "linux";
}

// FileTypePolicies::CanonicalizedExtension: the last extension of the base
// name once trailing dots and spaces are trimmed, lower-cased, ASCII only.
export function canonicalExtension(file: string): string {
  const trimmed = path.basename(file).replace(/[. ]+$/, "");
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0) return "";
  const extension = trimmed.slice(dot + 1);
  return /^[\x00-\x7f]*$/.test(extension) ? extension.toLowerCase() : "";
}

export function fileTypeSettings(file: string, platform = currentPlatform()): FileTypeSettings {
  const extension = canonicalExtension(file);
  return Object.hasOwn(FILE_TYPES, extension) ? FILE_TYPES[extension][platform] : DEFAULT_SETTINGS;
}

export interface DangerContext {
  filename: string;
  hasUserGesture: boolean;
  fromAddressBar: boolean;
  visitedReferrer(): boolean;
  platform?: Platform;
}

// DownloadTargetDeterminer::GetDangerLevel for a browser without enterprise
// policies, auto-open preferences or a "Save as" dialog. A type that is only
// risky without a gesture is fine when the user typed its URL, or clicked to
// it from a site they had visited before today.
export function downloadDangerLevel(context: DangerContext): DangerLevel {
  const [level] = fileTypeSettings(context.filename, context.platform);
  if (level !== "gesture") return level;
  if (context.fromAddressBar || (context.hasUserGesture && context.visitedReferrer())) return "safe";
  return level;
}

// VisitCountsToVisitedBefore: a visit counts once it happened before today.
export function visitedBeforeToday(firstVisit: number | null, now = Date.now()): boolean {
  if (firstVisit === null) return false;
  const midnight = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  return midnight(firstVisit) < midnight(now);
}

// Types Chrome never opens automatically, and any file whose danger the user
// overrode, are only opened for an extension after the user confirms.
export function opensOnlyAfterPrompt(file: string, danger: DownloadDanger, platform = currentPlatform()): boolean {
  const [level, autoOpen] = fileTypeSettings(file, platform);
  return danger !== "safe" || level !== "safe" || !autoOpen;
}

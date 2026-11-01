import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

import type { DownloadRecord } from "shared";

import { browsing } from "../../browsing";
import { safeRelativeFilename } from "../../browsing/downloads";
import type { ConflictAction, DownloadRequest, FilenameSuggestion } from "../../browsing/downloads";
import { extensionIcon } from "../action";
import { matchRegexFilters } from "../download-regex";
import type { LoadedExtension } from "../loaded";
import { hasUserGesture } from "../router";
import { hadRecentInput } from "../user-activation";
import type { Caller } from "../router";
import type { ExtensionService } from "../service";

type Item = chrome.downloads.DownloadItem;
type Query = chrome.downloads.DownloadQuery;

const DELTA_FIELDS = [
  "url",
  "finalUrl",
  "filename",
  "danger",
  "mime",
  "startTime",
  "endTime",
  "state",
  "canResume",
  "paused",
  "error",
  "totalBytes",
  "fileSize",
  "exists",
] as const;

const ORDER_FIELDS = new Set([
  "bytesReceived",
  "danger",
  "endTime",
  "exists",
  "fileSize",
  "filename",
  "finalUrl",
  "mime",
  "paused",
  "startTime",
  "state",
  "totalBytes",
  "url",
]);

// net::HttpUtil::IsSafeHeader: headers an extension may not set on a download.
const UNSAFE_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "access-control-request-private-network",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const DETERMINE_TIMEOUT_MS = 15_000;
// Chrome keeps answered determiners around this long to reject a second listener.
const DETERMINERS_LINGER_MS = 15_000;

const INVALID_ID = "Invalid downloadId";
const OPEN_PERMISSION = 'The "downloads.open" permission is required';
const INVISIBLE_CONTEXT = "Javascript execution context is not visible (tab, window, popup bubble)";

function iso(time: number | null): string | undefined {
  return time === null ? undefined : new Date(time).toISOString();
}

function downloadId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(INVALID_ID);
  return value;
}

export function checkDownloadHeaders(headers: unknown): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const header of (headers ?? []) as { name?: unknown; value?: unknown }[]) {
    if (typeof header.name !== "string" || !HEADER_NAME.test(header.name)) throw new Error("Invalid request header name");
    const lower = header.name.toLowerCase();
    if (UNSAFE_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) {
      throw new Error("Unsafe request header name");
    }
    const value = String(header.value ?? "");
    if (/[\0\r\n]/.test(value)) throw new Error("Invalid request header value");
    result[header.name] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

// What Chrome remembers of a download to work out onChanged deltas.
interface Snapshot {
  json: Partial<Item>;
  completed: boolean;
  removed: boolean;
}

export function downloadDelta(id: number, snapshot: Snapshot | undefined, current: Item): Record<string, unknown> | null {
  const delta: Record<string, unknown> = { id };
  const previous = snapshot ?? { json: {}, completed: false, removed: false };
  if (previous.completed) {
    if (previous.removed !== !current.exists) delta.exists = { current: current.exists, previous: !current.exists };
  } else {
    const before = previous.json as Record<string, unknown>;
    const after = current as unknown as Record<string, unknown>;
    for (const field of DELTA_FIELDS) {
      if (field in after) {
        if (!(field in before)) delta[field] = { current: after[field] };
        else if (before[field] !== after[field]) delta[field] = { current: after[field], previous: before[field] };
      } else if (field in before) {
        delta[field] = { previous: before[field] };
      }
    }
  }
  return Object.keys(delta).length > 1 ? delta : null;
}

interface Determination {
  waiting: Set<string>;
  reported: Set<string>;
  winner: { installedAt: number; suggestion: FilenameSuggestion } | null;
  finish(): void;
}

export function installDownloads(service: ExtensionService) {
  const { router } = service;
  const { downloads } = browsing();
  const options = { permission: "downloads" };
  const snapshots = new Map<number, Snapshot>();
  const determinations = new Map<number, Determination>();

  const allowed = (extension: LoadedExtension) => extension.hasApiPermission("downloads");
  const listening = (event: string) =>
    [...service.loaded.values()].some((extension) => allowed(extension) && service.events.hasListener(extension.id, event));

  const item = (record: DownloadRecord, byExtension = true): Item => {
    const removed = record.state === "complete" && !fs.existsSync(record.filename);
    const result: Item = {
      id: record.id,
      url: record.url,
      finalUrl: record.finalUrl,
      referrer: "",
      filename: record.filename,
      incognito: false,
      danger: record.danger,
      mime: record.mime,
      startTime: iso(record.startTime)!,
      state: record.state as Item["state"],
      paused: record.paused,
      canResume: downloads.canResume(record.id),
      bytesReceived: record.receivedBytes,
      totalBytes: record.totalBytes,
      fileSize: record.totalBytes,
      exists: !removed,
    };
    if (record.error) result.error = record.error as Item["error"];
    const endTime = iso(record.endTime);
    if (endTime) result.endTime = endTime;
    const remaining = record.state === "in_progress" ? downloads.remainingMs(record.id) : null;
    if (remaining !== null) result.estimatedEndTime = iso(Date.now() + remaining);
    if (byExtension && record.byExtensionId) {
      result.byExtensionId = record.byExtensionId;
      const extension = service.get(record.byExtensionId);
      if (extension) result.byExtensionName = extension.name;
    }
    return result;
  };

  downloads.created.add((record) => {
    const changes = listening("downloads.onChanged") || listening("downloads.onDeterminingFilename");
    if (!changes && !listening("downloads.onCreated")) return;
    // Chrome records who started a download only after announcing it.
    const created = item(record, false);
    service.broadcast("downloads.onCreated", (extension) => (allowed(extension) ? [created] : null));
    if (changes && !snapshots.has(record.id)) {
      snapshots.set(record.id, { json: record.state === "complete" ? {} : created, completed: false, removed: false });
    }
  });

  downloads.changed.add((record) => {
    if (!listening("downloads.onChanged")) return;
    const previous = snapshots.get(record.id);
    const current = item(record);
    const delta = downloadDelta(record.id, previous, current);
    snapshots.set(record.id, {
      json: previous?.completed ? {} : current,
      completed: record.state === "complete",
      removed: !current.exists,
    });
    if (delta) service.broadcast("downloads.onChanged", (extension) => (allowed(extension) ? [delta] : null));
  });

  downloads.erased.add((id) => {
    snapshots.delete(id);
    service.broadcast("downloads.onErased", (extension) => (allowed(extension) ? [id] : null));
  });

  service.events.listenerRemoved.add((extensionId, event) => {
    if (event === "downloads.onDeterminingFilename") {
      for (const determination of determinations.values()) {
        if (determination.waiting.delete(extensionId)) determination.reported.add(extensionId);
        if (determination.waiting.size === 0) determination.finish();
      }
    }
    if (event !== "downloads.onChanged" && event !== "downloads.onDeterminingFilename") return;
    if (!listening("downloads.onChanged") && !listening("downloads.onDeterminingFilename")) snapshots.clear();
  });

  // Every extension listening to onDeterminingFilename gets one say; when
  // several suggest a name, the most recently installed one wins.
  downloads.determiner = (record, suggestedPath) => {
    const determiners = [...service.loaded.values()].filter(
      (extension) => allowed(extension) && service.events.hasListener(extension.id, "downloads.onDeterminingFilename"),
    );
    if (determiners.length === 0) return null;
    return new Promise<FilenameSuggestion | null>((resolve) => {
      const determination: Determination = {
        waiting: new Set(determiners.map((extension) => extension.id)),
        reported: new Set(),
        winner: null,
        finish: () => {
          clearTimeout(timer);
          determination.waiting.clear();
          determination.finish = () => {};
          setTimeout(() => {
            if (determinations.get(record.id) === determination) determinations.delete(record.id);
          }, DETERMINERS_LINGER_MS).unref();
          resolve(determination.winner?.suggestion ?? null);
        },
      };
      const timer = setTimeout(() => determination.finish(), DETERMINE_TIMEOUT_MS);
      determinations.set(record.id, determination);
      const json = { ...item(record, false), filename: suggestedPath };
      // Chrome answers downloads.download with the new id before asking for a
      // name, so callers can listen for the rename first.
      setImmediate(() => {
        for (const extension of determiners) service.dispatch(extension.id, "downloads.onDeterminingFilename", [json]);
      });
    });
  };

  router.handle(
    "downloadsInternal.determineFilename",
    (caller, id, filename, conflictAction) => {
      const record = downloads.get(downloadId(id));
      if (!record) throw new Error(INVALID_ID);
      if (record.state !== "in_progress") throw new Error("Download must be in progress");
      const determination = determinations.get(record.id);
      if (!determination) throw new Error("Unexpected determineFilename call");
      const extensionId = caller.extension.id;
      if (determination.reported.has(extensionId)) {
        throw new Error(
          "Each extension may have at most one onDeterminingFilename listener between all of its renderer execution contexts.",
        );
      }
      if (!determination.waiting.delete(extensionId)) throw new Error("Unexpected determineFilename call");
      determination.reported.add(extensionId);
      const requested = typeof filename === "string" ? filename : "";
      const valid = requested === "" || safeRelativeFilename(requested) !== null;
      const action = (["uniquify", "overwrite", "prompt"].includes(conflictAction as string) ? conflictAction : "uniquify") as ConflictAction;
      if (valid && (requested !== "" || action !== "uniquify")) {
        const installedAt = caller.extension.record.installedAt;
        if (!determination.winner || installedAt >= determination.winner.installedAt) {
          determination.winner = { installedAt, suggestion: { filename: requested, conflictAction: action } };
        }
      }
      if (determination.waiting.size === 0) determination.finish();
      if (!valid) throw new Error("Invalid filename");
    },
    options,
  );

  const search = async (extensionId: string, query: Query): Promise<Item[]> => {
    if (query.limit !== undefined && query.limit < 0) throw new Error("Invalid query limit");
    const order = query.orderBy ?? ["-startTime"];
    if (order.some((raw) => raw !== "" && !ORDER_FIELDS.has(raw.replace(/^-/, "")))) throw new Error("Invalid orderBy field");
    const terms = (query.query ?? []).map((term) => term.toLowerCase());
    const time = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));
    const startedBefore = time(query.startedBefore);
    const startedAfter = time(query.startedAfter);
    const endedBefore = time(query.endedBefore);
    const endedAfter = time(query.endedAfter);
    const exact: (keyof Item & keyof Query)[] = [
      "id",
      "url",
      "finalUrl",
      "filename",
      "danger",
      "mime",
      "startTime",
      "endTime",
      "state",
      "paused",
      "error",
      "bytesReceived",
      "totalBytes",
      "fileSize",
      "exists",
    ];
    const all = downloads.list().map((record) => item(record));
    const regexFields = (
      [
        [query.filenameRegex, "filename"],
        [query.urlRegex, "url"],
        [query.finalUrlRegex, "finalUrl"],
      ] as const
    ).filter((entry): entry is readonly [string, "filename" | "url" | "finalUrl"] => entry[0] !== undefined);
    const regexMatches = await matchRegexFilters(
      extensionId,
      regexFields.map(([pattern, field]) => ({ pattern, subjects: all.map((download) => download[field]) })),
    );
    let results = all.filter((download, index) => {
      const haystack = `${download.url} ${download.filename}`.toLowerCase();
      for (const term of terms) {
        if (term.startsWith("-") ? haystack.includes(term.slice(1)) : !haystack.includes(term)) return false;
      }
      if (regexMatches.some((matches) => !matches[index])) return false;
      const started = Date.parse(download.startTime);
      const ended = download.endTime ? Date.parse(download.endTime) : undefined;
      if (startedBefore !== undefined && !(started < startedBefore)) return false;
      if (startedAfter !== undefined && !(started > startedAfter)) return false;
      if (endedBefore !== undefined && !(ended !== undefined && ended < endedBefore)) return false;
      if (endedAfter !== undefined && !(ended !== undefined && ended > endedAfter)) return false;
      if (query.totalBytesGreater !== undefined && !(download.totalBytes > query.totalBytesGreater)) return false;
      if (query.totalBytesLess !== undefined && !(download.totalBytes < query.totalBytesLess)) return false;
      return exact.every((key) => query[key] === undefined || query[key] === download[key]);
    });
    results.sort((a, b) => {
      for (const raw of order) {
        if (!raw) continue;
        const descending = raw.startsWith("-");
        const key = (descending ? raw.slice(1) : raw) as keyof Item;
        const left = a[key] ?? "";
        const right = b[key] ?? "";
        if (left === right) continue;
        return (left < right ? -1 : 1) * (descending ? -1 : 1);
      }
      return 0;
    });
    const limit = query.limit ?? 1000;
    if (limit > 0) results = results.slice(0, limit);
    return results;
  };

  const existing = (id: unknown): DownloadRecord => {
    const record = downloads.get(downloadId(id));
    if (!record) throw new Error(INVALID_ID);
    return record;
  };

  router.handle(
    "downloads.download",
    async (caller, options) => {
      const request = (options ?? {}) as chrome.downloads.DownloadOptions;
      if (typeof request.url !== "string") throw new Error("Invalid URL");
      const download: DownloadRequest = {
        url: request.url,
        filename: request.filename,
        conflictAction: request.conflictAction as DownloadRequest["conflictAction"],
        headers: checkDownloadHeaders(request.headers),
        method: request.method as DownloadRequest["method"],
        body: request.body,
        extensionId: caller.extension.id,
        allowFileAccess: caller.extension.allowsFileAccess,
      };
      return downloads.download(download);
    },
    options,
  );

  router.handle("downloads.search", (caller, query) => search(caller.extension.id, (query ?? {}) as Query), options);

  router.handle(
    "downloads.pause",
    (_caller, id) => {
      const record = existing(id);
      if (record.state !== "in_progress") throw new Error("Download must be in progress");
      if (!record.paused) downloads.pause(record.id);
    },
    options,
  );

  router.handle(
    "downloads.resume",
    (_caller, id) => {
      const record = existing(id);
      const cancelled = record.state === "interrupted" && record.error === "USER_CANCELED";
      if (cancelled || (record.state === "interrupted" && !downloads.canResume(record.id))) {
        throw new Error("DownloadItem.canResume must be true");
      }
      if (downloads.canResume(record.id)) downloads.resume(record.id);
    },
    options,
  );

  router.handle(
    "downloads.cancel",
    (_caller, id) => {
      const record = downloads.get(downloadId(id));
      if (record?.state === "in_progress") downloads.cancel(record.id);
    },
    options,
  );

  // Opening runs the file with the system's default app, so like Chrome it
  // needs a user gesture and, unless the user is typing in the calling page,
  // the user's confirmation. Types that can run code always ask: one click in
  // a popup is not consent to run what the extension just downloaded.
  const open = async (caller: Caller, id: unknown) => {
    const record = existing(id);
    if (!hasUserGesture(caller)) throw new Error("User gesture required");
    if (record.state !== "complete") throw new Error("Download must be complete");
    if (!fs.existsSync(record.filename)) throw new Error("Download file already deleted");
    const extension = caller.extension;
    if (!extension.hasApiPermission("downloads.open")) throw new Error(OPEN_PERMISSION);
    const window = service.currentWindow(caller);
    if (!window) throw new Error(INVISIBLE_CONTEXT);
    const trusted =
      !downloads.opensOnlyAfterPrompt(record.id) &&
      caller.kind === "frame" &&
      hadRecentInput(caller.contents) &&
      !extension.hasApiPermission("debugger");
    if (!trusted) {
      const accepted = await window.host.prompt({
        kind: "permissions",
        extensionId: extension.id,
        name: extension.name,
        icon: extensionIcon(extension, 48),
        // fixme: placeholder copy
        warnings: [`Open "${path.basename(record.filename)}"`],
      });
      if (!accepted) throw new Error(OPEN_PERMISSION);
      if (!downloads.get(record.id)) throw new Error("Download file already deleted");
    }
    downloads.open(record.id);
  };
  router.handle("downloads.open", open, options);

  router.handle("downloads.show", (_caller, id) => downloads.show(existing(id).id), options);
  router.handle("downloads.showDefaultFolder", () => downloads.showDefaultFolder(), options);

  router.handle(
    "downloads.erase",
    async (caller, query) => {
      const ids = (await search(caller.extension.id, (query ?? {}) as Query)).map((download) => download.id);
      for (const id of ids) downloads.erase(id);
      return ids;
    },
    options,
  );

  router.handle("downloads.removeFile", (_caller, id) => downloads.removeFile(existing(id).id), options);

  router.handle(
    "downloads.acceptDanger",
    async (caller, id) => {
      // Chrome removes the download when the caller has no page to show the
      // danger prompt in, which is always the case for a service worker.
      if (caller.kind === "worker") {
        const record = downloads.get(downloadId(id));
        if (record) downloads.erase(record.id);
        return;
      }
      const record = existing(id);
      if (record.state !== "in_progress") throw new Error("Download must be in progress");
      if (record.danger !== "file") throw new Error("Download must be dangerous");
      const window = service.currentWindow(caller);
      if (!window) throw new Error(INVISIBLE_CONTEXT);
      const extension = caller.extension;
      const kept = await window.host.prompt({
        kind: "permissions",
        extensionId: extension.id,
        name: extension.name,
        icon: extensionIcon(extension, 48),
        // fixme: placeholder copy
        warnings: [`Keep "${path.basename(record.filename)}", a type of file that can harm your computer`],
      });
      const current = downloads.get(record.id);
      if (!current) throw new Error(INVALID_ID);
      if (current.state !== "in_progress") throw new Error("Download must be in progress");
      if (current.danger !== "file") return;
      if (kept) downloads.accept(record.id);
      else downloads.discard(record.id);
    },
    options,
  );

  router.handle(
    "downloads.getFileIcon",
    async (_caller, id, iconOptions) => {
      const record = existing(id);
      if (!record.filename) throw new Error("Filename not yet determined");
      const size = (iconOptions as { size?: number } | undefined)?.size ?? 32;
      if (![16, 32].includes(size)) throw new Error("Invalid `size`. Must be either `16` or `32`.");
      try {
        const icon = await app.getFileIcon(record.filename, { size: size === 16 ? "small" : "normal" });
        return icon.toDataURL();
      } catch {
        throw new Error("Icon not found");
      }
    },
    options,
  );

  router.handle("downloads.setShelfEnabled", () => undefined, options);
  router.handle(
    "downloads.setUiOptions",
    (caller) => {
      if (!caller.extension.hasApiPermission("downloads.ui")) {
        throw new Error('downloads.setUiOptions requires the "downloads.ui" permission');
      }
    },
    options,
  );
}

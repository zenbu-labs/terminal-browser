import fs from "node:fs";

import { app } from "electron";

import type { DownloadRecord } from "shared";

import { browsing } from "../../browsing";
import type { DownloadRequest } from "../../browsing/downloads";
import type { LoadedExtension } from "../loaded";
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

function iso(time: number | null): string | undefined {
  return time === null ? undefined : new Date(time).toISOString();
}

function downloadId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Invalid downloadId");
  return value;
}

function regex(source: string | undefined): RegExp | null {
  if (source === undefined) return null;
  try {
    return new RegExp(source);
  } catch {
    throw new Error("Invalid query filenameRegex");
  }
}

export function installDownloads(service: ExtensionService) {
  const { router } = service;
  const { downloads } = browsing();
  const options = { permission: "downloads" };
  const sent = new Map<number, Item>();

  const item = (record: DownloadRecord): Item => {
    const exists = record.state === "complete" ? fs.existsSync(record.filename) : record.state === "in_progress";
    const extension = record.byExtensionId ? service.get(record.byExtensionId) : null;
    const result: Item = {
      id: record.id,
      url: record.url,
      finalUrl: record.finalUrl,
      referrer: "",
      filename: record.filename,
      incognito: false,
      danger: "safe",
      mime: record.mime,
      startTime: iso(record.startTime)!,
      state: record.state as Item["state"],
      paused: record.paused,
      canResume: downloads.canResume(record.id),
      bytesReceived: record.receivedBytes,
      totalBytes: record.totalBytes > 0 ? record.totalBytes : -1,
      fileSize: record.state === "complete" ? record.totalBytes : record.totalBytes > 0 ? record.totalBytes : -1,
      exists,
    };
    const endTime = iso(record.endTime);
    if (endTime) result.endTime = endTime;
    if (record.error) result.error = record.error as Item["error"];
    if (record.byExtensionId) {
      result.byExtensionId = record.byExtensionId;
      if (extension) result.byExtensionName = extension.name;
    }
    return result;
  };

  const allowed = (extension: LoadedExtension) => extension.hasApiPermission("downloads");

  downloads.created.add((record) => {
    const created = item(record);
    sent.set(record.id, created);
    service.broadcast("downloads.onCreated", (extension) => (allowed(extension) ? [created] : null));
  });
  downloads.changed.add((record) => {
    const current = item(record);
    const previous = sent.get(record.id);
    sent.set(record.id, current);
    if (!previous) return;
    const delta: Record<string, unknown> = { id: record.id };
    for (const field of DELTA_FIELDS) {
      if (previous[field] !== current[field]) delta[field] = { previous: previous[field], current: current[field] };
    }
    if (Object.keys(delta).length === 1) return;
    service.broadcast("downloads.onChanged", (extension) => (allowed(extension) ? [delta] : null));
  });
  downloads.erased.add((id) => {
    sent.delete(id);
    service.broadcast("downloads.onErased", (extension) => (allowed(extension) ? [id] : null));
  });

  const search = (query: Query): Item[] => {
    const terms = (query.query ?? []).map((term) => term.toLowerCase());
    const filenameRegex = regex(query.filenameRegex);
    const urlRegex = regex(query.urlRegex);
    const finalUrlRegex = regex(query.finalUrlRegex);
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
    let results = downloads
      .list()
      .map(item)
      .filter((download) => {
        const haystack = `${download.url} ${download.filename}`.toLowerCase();
        for (const term of terms) {
          if (term.startsWith("-") ? haystack.includes(term.slice(1)) : !haystack.includes(term)) return false;
        }
        if (filenameRegex && !filenameRegex.test(download.filename)) return false;
        if (urlRegex && !urlRegex.test(download.url)) return false;
        if (finalUrlRegex && !finalUrlRegex.test(download.finalUrl)) return false;
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
    const order = query.orderBy ?? ["-startTime"];
    results.sort((a, b) => {
      for (const raw of order) {
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
    for (const result of results) if (!sent.has(result.id)) sent.set(result.id, result);
    return results;
  };

  router.handle(
    "downloads.download",
    async (caller, options) => {
      const request = (options ?? {}) as chrome.downloads.DownloadOptions;
      if (typeof request.url !== "string") throw new Error("Invalid URL");
      const headers: Record<string, string> = {};
      for (const header of request.headers ?? []) {
        if (typeof header.name !== "string" || !header.name) throw new Error("Invalid request header name");
        headers[header.name] = String(header.value ?? "");
      }
      const download: DownloadRequest = {
        url: request.url,
        filename: request.filename,
        conflictAction: request.conflictAction as DownloadRequest["conflictAction"],
        headers: Object.keys(headers).length ? headers : undefined,
        method: request.method as DownloadRequest["method"],
        body: request.body,
        extensionId: caller.extension.id,
      };
      return downloads.download(download);
    },
    options,
  );

  router.handle("downloads.search", (_caller, query) => search((query ?? {}) as Query), options);

  router.handle("downloads.pause", (_caller, id) => downloads.pause(downloadId(id)), options);
  router.handle("downloads.resume", (_caller, id) => downloads.resume(downloadId(id)), options);
  router.handle("downloads.cancel", (_caller, id) => downloads.cancel(downloadId(id)), options);

  router.handle(
    "downloads.open",
    (caller, id) => {
      if (!caller.extension.hasApiPermission("downloads.open")) {
        throw new Error('The "downloads.open" permission is required');
      }
      downloads.open(downloadId(id));
    },
    options,
  );

  router.handle("downloads.show", (_caller, id) => downloads.show(downloadId(id)), options);
  router.handle("downloads.showDefaultFolder", () => downloads.showDefaultFolder(), options);

  router.handle(
    "downloads.erase",
    (_caller, query) => {
      const ids = search((query ?? {}) as Query).map((download) => download.id);
      for (const id of ids) downloads.erase(id);
      return ids;
    },
    options,
  );

  router.handle("downloads.removeFile", (_caller, id) => downloads.removeFile(downloadId(id)), options);

  router.handle(
    "downloads.acceptDanger",
    (_caller, id) => {
      if (!downloads.get(downloadId(id))) throw new Error("Invalid downloadId");
      throw new Error("Download is not dangerous");
    },
    options,
  );

  router.handle(
    "downloads.getFileIcon",
    async (_caller, id, iconOptions) => {
      const record = downloads.get(downloadId(id));
      if (!record) throw new Error("Invalid downloadId");
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
  router.handle("downloads.setUiOptions", () => undefined, options);
}

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { encodeRecording } from "@zenbu-labs/pixel";
import { clampRect, moveObject } from "./model";
import { buildSampleTimes } from "./samples";
import { lastIndexAtOrBefore } from "./recorder";
import type { MarkupStore } from "./model";
import type { Recorder } from "./recorder";

export interface Keyframe {
  frame: number;
  tMs: number;
  url: string;
  title: string;
}

export interface CompositeOptions {
  recorder: Recorder;
  markup: MarkupStore;
  page: { url: string; title: string };
  fontFile: string;
  shots: Keyframe[];
  trim: { startMs: number; endMs: number } | null;
}

const RETRY_HINT =
  "The recording is still being encoded. Re-read this file in a few seconds until status is " +
  '"ready". If it stays "processing" for minutes the encode was interrupted.';

const STILLS_READY_HINT =
  "The keyframes, crops, and markup listed here are already written and safe to read now. " +
  'Only video.mp4 is still encoding: re-read this file until status is "ready", using progress ' +
  "to judge how close it is. If it stays \"processing\" for minutes the encode was interrupted.";

function manifestBase(page: { url: string; title: string }, status: string) {
  return {
    version: 1,
    kind: "terminal-browser-recording",
    status,
    createdAt: new Date().toISOString(),
    page,
  };
}

function drawingShotFrames(markup: MarkupStore, shots: readonly Keyframe[]): number[] {
  return markup
    .annotatedKeys()
    .filter((key) => markup.drawables(key).length > 0)
    .filter((key) => !shots.some((shot) => shot.tMs === key));
}

function processingManifest(
  page: { url: string; title: string },
  progress: { percent: number; elapsedMs: number },
  stills?: object,
) {
  return {
    ...manifestBase(page, "processing"),
    progress: { ...progress, updatedAt: new Date().toISOString() },
    ...stills,
    hint: stills ? STILLS_READY_HINT : RETRY_HINT,
  };
}

export function writeProcessingManifest(dir: string, page: { url: string; title: string }): string {
  // sync? eh
  const manifestPath = path.join(dir, "recording.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(processingManifest(page, { percent: 0, elapsedMs: 0 }), null, 2),
  );
  return manifestPath;
}

export function writeFailedManifest(dir: string, page: { url: string; title: string }, error: string) {
  fs.writeFileSync(
    path.join(dir, "recording.json"),
    JSON.stringify({ ...manifestBase(page, "failed"), error }, null, 2),
  );
}

export async function compositeRecording(options: CompositeOptions): Promise<void> {
  const { recorder, markup, page, trim } = options;
  const frames = recorder.frames;
  if (frames.length === 0) throw new Error("Nothing captured");
  const dir = recorder.dir;

  const trimStart = trim?.startMs ?? 0;
  const durationMs = trim ? trim.endMs - trim.startMs : recorder.durationMs();
  const trimEnd = trimStart + durationMs;
  const inWindow = (tMs: number) => tMs >= trimStart && tMs <= trimEnd;
  const shiftTime = <T extends { tMs: number }>(point: T): T => ({ ...point, tMs: point.tMs - trimStart });
  const pointer = recorder.pointerTrail.filter((p) => inWindow(p.tMs)).map(shiftTime);
  const clicks = recorder.clicks.filter((p) => inWindow(p.tMs)).map(shiftTime);
  const links = recorder.links.filter((l) => inWindow(l.tMs)).map(shiftTime);
  const frameTimes = frames
    .map((frame) => Math.round(frame.tMs))
    .filter((tMs) => (trim ? tMs > trimStart && tMs <= trimEnd : true))
    .map((tMs) => tMs - trimStart);
  const keyInWindow = (key: number) => key >= trimStart && key < trimEnd;

  const base = frames[0];
  const sampleTimes = buildSampleTimes({
    frameTimes,
    pointer,
    clicks,
    links,
    durationMs: Math.round(durationMs),
  });
  const sampleEnd = (key: number) => {
    const at = lastIndexAtOrBefore(sampleTimes, key, (t) => t);
    return sampleTimes[at + 1] ?? Math.round(durationMs);
  };

  const jobRegion = (() => {
    const found = markup.videoCrop();
    return found ? clampRect(found, base, 2) : null;
  })();
  const shift = { x: jobRegion?.x ?? 0, y: jobRegion?.y ?? 0 };
  const shifted = (point: { tMs: number; x: number; y: number }) => ({
    tMs: point.tMs,
    x: point.x - shift.x,
    y: point.y - shift.y,
  });

  const baseSize = jobRegion ?? base;
  const outWidth = baseSize.width + (baseSize.width % 2);
  const outHeight = baseSize.height + (baseSize.height % 2);
  const cropKeys = markup.annotatedKeys().filter((key) => markup.crop(key)).filter(keyInWindow);
  const annotatedKeys = markup
    .annotatedKeys()
    .filter((key) => markup.drawables(key).length > 0)
    .filter(keyInWindow);

  const crops = cropKeys.map((key) => {
    const rect = markup.crop(key)!;
    const clamped = clampRect(
      { x: rect.x - shift.x, y: rect.y - shift.y, width: rect.width, height: rect.height },
      baseSize,
      1,
    );
    return { key, tMs: key - trimStart, name: `crop-${key - trimStart}.png`, rect: clamped };
  });

  const drawingShots = drawingShotFrames(markup, options.shots)
    .filter(keyInWindow)
    .map((key) => ({
      frame: recorder.frameAt(key) ?? 0,
      tMs: key - trimStart,
      url: page.url,
      title: page.title,
      crop: crops.find((crop) => crop.key === key)?.rect ?? null,
    }));
  const exportShots = [
    ...options.shots
      .filter((shot) => inWindow(shot.tMs))
      .map((shot) => ({
        ...shiftTime(shot),
        crop: null as { x: number; y: number; width: number; height: number } | null,
      })),
    ...drawingShots,
  ]
    .sort((a, b) => a.tMs - b.tMs)
    .map((shot) => ({ ...shot, name: `keyframe-${shot.tMs}.png` }));


  
  const job = {
    videoOut: path.join(dir, "video.mp4"),
    cropsDir: path.join(dir, "crops"),
    keyframesDir: path.join(dir, "keyframes"),
    captureDir: recorder.captureDir,
    durationMs: Math.round(durationMs),
    fontFile: options.fontFile,
    trim: trim ? { startMs: trimStart, endMs: trimEnd } : undefined,
    markup: annotatedKeys.map((key) => ({
      atMs: key - trimStart,
      untilMs: sampleEnd(key - trimStart),
      objects: markup
        .drawables(key)
        .map((object) => moveObject(object, -shift.x, -shift.y)),
    })),
    crops: crops.map((crop) => ({
      frame: recorder.frameAt(crop.key) ?? 0,
      tMs: crop.tMs,
      file: path.join(dir, "crops", crop.name),
      rect: crop.rect,
    })),
    pointer: pointer.map(shifted),
    clicks: clicks.map(shifted),
    links,
    region: jobRegion,
    shots: exportShots.map((shot) => ({
      frame: shot.frame,
      tMs: shot.tMs,
      file: path.join(dir, "keyframes", shot.name),
      url: shot.url,
      takenAt: new Date(recorder.startWallMs + trimStart + shot.tMs).toISOString(),
      crop: shot.crop,
    })),
  };

  const annotations = annotatedKeys.map((key) => {
    const objects = markup.drawables(key);
    return {
      atMs: key - trimStart,
      shownUntilMs: sampleEnd(key - trimStart),
      tools: [...new Set(objects.map((object) => object.kind))],
      texts: objects.flatMap((object) =>
        object.kind === "text" && object.text.trim() ? [object.text.trim()] : [],
      ),
    };
  });
  const stills = {
    drops: recorder.drops
      .filter((drop) => inWindow(drop.tMs))
      .map((drop) => ({ atMs: Math.round(drop.tMs - trimStart), count: drop.count })),
    annotations,
    input: {
      clicksMs: clicks.map((click) => Math.round(click.tMs)),
      reloadsMs: recorder.reloads
        .filter((reload) => inWindow(reload.tMs))
        .map((reload) => Math.round(reload.tMs - trimStart)),
      pageLoadsMs: recorder.loads
        .filter((load) => inWindow(load.tMs))
        .map((load) => Math.round(load.tMs - trimStart)),
    },
    links: links.map((link) => ({ atMs: Math.round(link.tMs), url: link.url })),
    keyframes: exportShots.map((shot) => ({
      path: path.join("keyframes", shot.name),
      atMs: shot.tMs,
      url: shot.url,
      title: shot.title,
    })),
    crops: crops.map((crop) => ({
      path: path.join("crops", crop.name),
      atMs: crop.tMs,
      rect: crop.rect,
    })),
    markupData: "markup.json",
  };
  const markupData = {
    states: markup
      .annotatedKeys()
      .filter(keyInWindow)
      .map((key) => ({
        atMs: key - trimStart,
        objects: markup.ownObjects(key),
      })),
  };

  const startedAt = Date.now();
  await encodeRecording(JSON.stringify({ ...job, stage: "stills" }));
  await fsp.writeFile(path.join(dir, "markup.json"), JSON.stringify(markupData, null, 2));
  await fsp.writeFile(
    path.join(dir, "recording.json"),
    JSON.stringify(
      processingManifest(page, { percent: 0, elapsedMs: Date.now() - startedAt }, stills),
      null,
      2,
    ),
  );

  let lastWrite = 0;
  let encodeDone = false;
  let progressWrite = Promise.resolve();
  const onProgress = (percent: number) => {
    const now = Date.now();
    if (encodeDone || (percent < 100 && now - lastWrite < 250)) return;
    lastWrite = now;
    const body = processingManifest(page, { percent, elapsedMs: now - startedAt }, stills);
    progressWrite = progressWrite
      .then(() => fsp.writeFile(path.join(dir, "recording.json"), JSON.stringify(body, null, 2)))
      .catch(() => {});
  };
  await encodeRecording(JSON.stringify({ ...job, stage: "video" }), onProgress);
  encodeDone = true;
  await progressWrite;

  const manifest = {
    ...manifestBase(page, "ready"),
    video: {
      path: "video.mp4",
      durationMs: Math.round(durationMs),
      width: outWidth,
      height: outHeight,
      vfr: true,
    },
    ...stills,
    hint:
      "video.mp4 plays the recording with real frame timing; " +
      "annotations list when drawn markup is visible; links list new tabs opened during capture; " +
      "keyframes are user-picked moments with a metadata header; crops are standalone annotated " +
      "screenshots taken at atMs. Paths are relative to this file.",
  };
  await fsp.writeFile(path.join(dir, "recording.json"), JSON.stringify(manifest, null, 2));
  await recorder.deleteRawFrames();
}

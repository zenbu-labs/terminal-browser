import { execFileSync } from "node:child_process";
import path from "node:path";

import { debug } from "../debug";
import { PROCESS_LIST_ARGS, ancestry, parseProcesses } from "./processes";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Screen extends Rect {
  scale: number;
}

const APP_EXECUTABLE = /\.app\/Contents\/MacOS\/[^/]+$/;

const WINDOW_AND_SCREENS_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function run(argv) {
  const pid = Number(argv[0]);
  const options = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options, $.kCGNullWindowID)));
  const front = windows.find((window) => window.kCGWindowOwnerPID === pid && window.kCGWindowLayer === 0);
  if (!front) return "";
  const { X, Y, Width, Height } = front.kCGWindowBounds;
  const screens = [];
  for (let i = 0; i < $.NSScreen.screens.count; i++) {
    const screen = $.NSScreen.screens.objectAtIndex(i);
    const { origin, size } = screen.frame;
    screens.push({ x: origin.x, y: origin.y, width: size.width, height: size.height, scale: screen.backingScaleFactor });
  }
  return JSON.stringify({ window: { x: X, y: Y, width: Width, height: Height }, screens });
}`;

function appBundle(command: string): string | null {
  return command.match(/^(.*?\.app)\//)?.[1] ?? null;
}

export function terminalAppPid(processList: string, tty: string): number | null {
  const processes = parseProcesses(processList);
  const ttyName = path.basename(tty);
  if (ttyName === "??") return null;
  const isApp = (pid: number) => {
    const info = processes.get(pid)!;
    return info.tty !== ttyName && APP_EXECUTABLE.test(info.command);
  };
  for (const [pid, info] of processes) {
    if (info.tty !== ttyName) continue;
    const chain = ancestry(pid, processes);
    const first = chain.findIndex(isApp);
    if (first < 0) continue;
    const bundle = appBundle(processes.get(chain[first])!.command);
    let app = chain[first];
    for (const ancestor of chain.slice(first + 1)) {
      if (appBundle(processes.get(ancestor)!.command) !== bundle) break;
      app = ancestor;
    }
    return app;
  }
  return null;
}

// window uses top-left origin coordinates, screens use bottom-left origin relative to the first (primary) screen
export function scaleOfWindow(window: Rect, screens: Screen[]): number | null {
  if (screens.length === 0) return null;
  const bottom = screens[0].height - window.y - window.height;
  let best: Screen | null = null;
  let bestArea = 0;
  for (const screen of screens) {
    const width = Math.min(window.x + window.width, screen.x + screen.width) - Math.max(window.x, screen.x);
    const height = Math.min(bottom + window.height, screen.y + screen.height) - Math.max(bottom, screen.y);
    const area = Math.max(0, width) * Math.max(0, height);
    if (area > bestArea) {
      best = screen;
      bestArea = area;
    }
  }
  return best?.scale ?? null;
}

export function scaleFromLookup(output: string): number | null {
  if (!output.trim()) return null;
  const { window, screens } = JSON.parse(output) as { window: Rect; screens: Screen[] };
  return scaleOfWindow(window, screens);
}

export function appWindowScale(pid: number): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync("osascript", ["-l", "JavaScript", "-e", WINDOW_AND_SCREENS_SCRIPT, String(pid)], {
      encoding: "utf8",
      timeout: 500,
    });
    return scaleFromLookup(output);
  } catch (error) {
    debug("window scale lookup failed", String(error));
    return null;
  }
}

export function terminalWindowScale(tty: string): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const processList = execFileSync("ps", PROCESS_LIST_ARGS, { encoding: "utf8", timeout: 500 });
    const pid = terminalAppPid(processList, tty);
    return pid === null ? null : appWindowScale(pid);
  } catch (error) {
    debug("terminal app lookup failed", String(error));
    return null;
  }
}

import fs from "node:fs";
import path from "node:path";

import type { Terminal } from "./terminal";

export type GraphicsSupport = "supported" | "unsupported" | "unknown";

export const SKIP_ENV = "TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK";

const PROBE_ID = 4207;

const PROBE_TIMEOUT_MS = 500;

function passthrough(seq: string): string {
  return `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function probeSequence(wrap: boolean): string {
  const query = `\x1b_Gi=${PROBE_ID},a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\`;
  return `${wrap ? passthrough(query) : query}\x1b[c`;
}

function graphicsReply(buffer: string): boolean | null {
  const needle = `Gi=${PROBE_ID};`;
  const at = buffer.indexOf(needle);
  if (at < 0) return null;
  const rest = buffer.slice(at + needle.length);
  if (rest.length < 2) return null;
  return rest.startsWith("OK");
}

interface NativeConsole {
  graphics(timeoutMs: number): GraphicsSupport;
  close(): void;
}

function nativeModule(): { Console: new () => NativeConsole } | null {
  const relatives = ["browser/native/pixel.node", "engine/packages/pixel-react/native/pixel.node"];
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    for (const relative of relatives) {
      const candidate = path.join(dir, relative);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      if (fs.existsSync(candidate)) return require(candidate);
    }
    if (path.dirname(dir) === dir) return null;
  }
}

// A program that opens windows is given no console, so on windows the question
// goes to the engine, which opens one by name.
function askTheEngine(): GraphicsSupport | null {
  try {
    const native = nativeModule();
    if (!native) return null;
    const console = new native.Console();
    try {
      return console.graphics(PROBE_TIMEOUT_MS);
    } finally {
      console.close();
    }
  } catch {
    return null;
  }
}

/** Asks the terminal whether it can draw images. Only works on a real tty. */
export function probeGraphics(terminal: Terminal | null): Promise<GraphicsSupport> {
  if (process.platform === "win32") {
    const answer = askTheEngine();
    if (answer) return Promise.resolve(answer);
  }
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || !stdin.setRawMode) {
    return Promise.resolve("unknown");
  }

  const wasRaw = stdin.isRaw;

  return new Promise<GraphicsSupport>((resolve) => {
    let buffer = "";
    let timer: NodeJS.Timeout | null = null;
    let done = false;

    const finish = (graphics: GraphicsSupport) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stdin.off("data", onData);
      try {
        if (!wasRaw) stdin.setRawMode?.(false);
      } catch { }
      if (!stdin.isPaused()) stdin.pause();
      resolve(graphics);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("binary");
      const reply = graphicsReply(buffer);
      if (reply !== null) return finish(reply ? "supported" : "unsupported");
      if (buffer.length > 1024) finish("unknown");
    };

    try {
      stdin.setRawMode(true);
    } catch {
      return finish("unknown");
    }
    stdin.resume();
    stdin.on("data", onData);

    timer = setTimeout(() => finish("unknown"), PROBE_TIMEOUT_MS);

    try {
      fs.writeSync(1, probeSequence(terminal?.wrapper === "tmux"));
    } catch {
      finish("unknown");
    }
  });
}

export function panePixels(): Promise<{ width: number; height: number } | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || !stdin.setRawMode) return Promise.resolve(null);

  const wasRaw = stdin.isRaw;
  return new Promise((resolve) => {
    let buffer = "";
    let timer: NodeJS.Timeout | null = null;
    let done = false;

    const finish = (value: { width: number; height: number } | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stdin.off("data", onData);
      try {
        if (!wasRaw) stdin.setRawMode?.(false);
      } catch { }
      if (!stdin.isPaused()) stdin.pause();
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("binary");
      const reply = /\x1b\[4;(\d+);(\d+)t/.exec(buffer);
      if (reply) finish({ width: Number(reply[2]), height: Number(reply[1]) });
    };

    try {
      stdin.setRawMode(true);
    } catch {
      return finish(null);
    }
    stdin.resume();
    stdin.on("data", onData);
    timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);

    try {
      fs.writeSync(1, "\x1b[14t");
    } catch {
      finish(null);
    }
  });
}

export function unsupportedGraphicsMessage(color = false): string {
  const sgr = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  return [
    "",
    `  ${sgr("1", "This terminal cannot show images, which terminal-browser needs.")}`,
    "",
    `  ${sgr("2", "We recommend Ghostty:")}`,
    `  ${sgr("4", "https://ghostty.org/download")}`,
    "",
    `  ${sgr("2", "Note: any terminal that supports the kitty graphics protocol is supported")}`,
    "",
    // Windows cannot run this check from inside a program that opens windows,
    // so a terminal that does draw images has no way to say so here.
    ...(process.platform === "win32"
      ? [`  ${sgr("2", `If this terminal does draw images, set ${SKIP_ENV}=1`)}`, ""]
      : []),
  ].join("\n");
}

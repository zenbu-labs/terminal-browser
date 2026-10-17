import fs from "node:fs";

import type { Terminal } from "./terminal";

export type GraphicsSupport = "supported" | "unsupported" | "unknown";

export const SKIP_ENV = "PIXEL_SKIP_GRAPHICS_CHECK";

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

function deviceAttributes(buffer: string): string[] | null {
  const reply = /\x1b\[\?([\d;]*)c/.exec(buffer);
  return reply ? reply[1].split(";") : null;
}

function drawsIterm2(env: NodeJS.ProcessEnv): boolean {
  return env.LC_TERMINAL === "iTerm2" || env.TERM_PROGRAM === "iTerm.app";
}

export function probeGraphics(terminal: Terminal | null): Promise<GraphicsSupport> {
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
      if (reply === true || drawsIterm2(process.env)) return finish("supported");
      const attributes = deviceAttributes(buffer);
      if (attributes?.includes("4")) return finish("supported");
      if (attributes) return finish(reply === false ? "unsupported" : "unknown");
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
    `  ${sgr("1", "Unsupported terminal: this terminal cannot display graphics")}`,
    "",
    `  ${sgr("2", "We recommend Ghostty:")}`,
    `  ${sgr("4", "https://ghostty.org/download")}`,
    "",
    `  ${sgr("2", "Note: any terminal that supports the kitty graphics protocol, sixel or iTerm2 images is supported")}`,
    "",
  ].join("\n");
}

import util from "node:util";

import { consoleLogs } from "./stores";
import type { LogLevel } from "./store";

let installed = false;

export function installConsoleCapture() {
  if (installed) return;
  installed = true;

  const capture =
    (level: LogLevel) =>
    (...args: unknown[]) => {
      consoleLogs.push(level, "console", util.format(...args));
    };
  console.log = capture("info");
  console.info = capture("info");
  console.warn = capture("warn");
  console.error = capture("error");
  console.debug = capture("debug");
  console.trace = (...args: unknown[]) => {
    const stack = new Error().stack?.split("\n").slice(2).join("\n") ?? "";
    consoleLogs.push("debug", "console", `Trace: ${util.format(...args)}\n${stack}`);
  };

  const captureStream = (stream: NodeJS.WriteStream, level: LogLevel, target: string) => {
    stream.write = ((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void
    ): boolean => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString(
              typeof encodingOrCb === "string" ? encodingOrCb : "utf8"
            );
      const trimmed = text.replace(/\n$/, "");
      if (trimmed.length > 0) consoleLogs.push(level, target, trimmed);
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      callback?.(null);
      return true;
    }) as typeof stream.write;
  };
  captureStream(process.stdout, "info", "stdout");
  captureStream(process.stderr, "error", "stderr");
}

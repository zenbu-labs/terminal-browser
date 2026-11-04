import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

// Page titles, URLs, page text and extension manifests are written by strangers.
// Their control characters are printed as visible escapes (\e, \x07, ‮) so
// they can't move the cursor, set the clipboard, retitle the window or reorder text.
const CONTROL = /[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;
const CONTROL_EXCEPT_NEWLINE_AND_TAB = /[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;

const NAMED: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\x1b": "\\e" };

function hexEscape(char: string): string {
  return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

function unicodeEscape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function visible(char: string): string {
  return NAMED[char] ?? (char.charCodeAt(0) < 0x80 ? hexEscape(char) : unicodeEscape(char));
}

export function oneLine(text: string): string {
  return text.replace(CONTROL, visible);
}

export function printable(text: string): string {
  return text.replace(CONTROL_EXCEPT_NEWLINE_AND_TAB, visible);
}

export function safeJsonText(json: string): string {
  return json.replace(CONTROL_EXCEPT_NEWLINE_AND_TAB, unicodeEscape);
}

export function safeJson(value: unknown, indent: number | undefined = 2): string {
  return safeJsonText(JSON.stringify(value, null, indent) ?? "null");
}

export function out(text: string) {
  process.stdout.write(printable(text));
}

export function err(text: string) {
  process.stderr.write(printable(text));
}

export function outJson(value: unknown, indent?: number) {
  process.stdout.write(`${safeJson(value, indent)}\n`);
}

export function errOwnStyling(text: string) {
  process.stderr.write(text);
}

function relay(from: Readable, to: NodeJS.WriteStream, clean: (text: string) => string): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  return new Promise((resolve) => {
    from.on("data", (chunk: Buffer) => to.write(clean(decoder.decode(chunk, { stream: true }))));
    from.on("end", () => {
      to.write(clean(decoder.decode()));
      resolve();
    });
    from.on("error", () => resolve());
  });
}

export interface RelayOptions {
  argsFd?: number;
  json?: boolean;
}

export async function runRelayed(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: RelayOptions = {},
): Promise<number> {
  const clean = (options.json ?? args.includes("--json")) ? safeJsonText : printable;
  const extraFds = options.argsFd !== undefined ? [options.argsFd] : [];
  const child = spawn(binary, args, { env, stdio: ["inherit", "pipe", "pipe", ...extraFds] });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const [code] = await Promise.all([exited, relay(child.stdout!, process.stdout, clean), relay(child.stderr!, process.stderr, clean)]);
  return code;
}

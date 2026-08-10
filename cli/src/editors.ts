import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEY = "terminal.integrated.enableImages";

export type EditorOutcome = "enabled" | "created" | "already" | "failed";

export interface EditorResult {
  name: string;
  settings: string;
  outcome: EditorOutcome;
  error?: string;
}

function userDirs(): { name: string; dir: string }[] {
  const support =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  let names: string[];
  try {
    names = fs.readdirSync(support);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, dir: path.join(support, name, "User") }))
    .filter((entry) => fs.existsSync(path.join(entry.dir, "globalStorage", "state.vscdb")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function skipLineComment(source: string, at: number): number {
  const end = source.indexOf("\n", at);
  return end < 0 ? source.length : end;
}

function skipBlockComment(source: string, at: number): number {
  const end = source.indexOf("*/", at + 2);
  return end < 0 ? source.length : end + 2;
}

function readString(source: string, at: number): { value: string; end: number } {
  let index = at + 1;
  let value = "";
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (ch === '"') return { value, end: index + 1 };
    value += ch;
    index += 1;
  }
  return { value, end: index };
}

function skipTrivia(source: string, at: number): number {
  let index = at;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (!/\s/.test(ch)) return index;
    index += 1;
  }
  return index;
}

function containerEnd(source: string, at: number): number {
  let index = at;
  let depth = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (ch === '"') {
      index = readString(source, index).end;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

function valueEnd(source: string, at: number): number {
  const ch = source[at];
  if (ch === '"') return readString(source, at).end;
  if (ch === "{" || ch === "[") return containerEnd(source, at);
  let index = at;
  while (index < source.length) {
    const current = source[index];
    if (/\s/.test(current) || ",}]".includes(current)) break;
    if (current === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) break;
    index += 1;
  }
  return index;
}

interface Located {
  valueStart: number;
  valueEnd: number;
  value: string;
}


function locate(source: string, key: string): Located | null {
  let index = 0;
  let depth = 0;
  let found: Located | null = null;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (ch === '"') {
      const literal = readString(source, index);
      if (depth === 1 && literal.value === key) {
        const colon = skipTrivia(source, literal.end);
        if (source[colon] === ":") {
          const start = skipTrivia(source, colon + 1);
          const end = valueEnd(source, start);
          found = { valueStart: start, valueEnd: end, value: source.slice(start, end) };
        }
      }
      index = literal.end;
      continue;
    }
    index += 1;
  }
  return found;
}

function rootBrace(source: string): number {
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (ch === "{") return index;
    index += 1;
  }
  return -1;
}

function indentOf(source: string, afterBrace: number): string {
  const rest = source.slice(afterBrace);
  const match = rest.match(/\n([ \t]+)\S/);
  return match ? match[1] : "  ";
}

function withSetting(source: string): string | null {
  const brace = rootBrace(source);
  if (brace < 0) return null;
  const indent = indentOf(source, brace + 1);
  const rest = source.slice(brace + 1);
  const empty = source[skipTrivia(source, brace + 1)] === "}";
  const line = `\n${indent}"${KEY}": true${empty ? "" : ","}`;
  const gap = empty && !rest.startsWith("\n") ? "\n" : "";
  return `${source.slice(0, brace + 1)}${line}${gap}${rest}`;
}

function writeAtomic(file: string, contents: string) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const temporary = `${target}.terminal-browser.tmp`;
  fs.writeFileSync(temporary, contents);
  try {
    fs.chmodSync(temporary, fs.statSync(target).mode);
  } catch {}
  fs.renameSync(temporary, target);
}

function applyTo(settings: string): EditorOutcome {
  if (!fs.existsSync(settings)) {
    writeAtomic(settings, `{\n  "${KEY}": true\n}\n`);
    return "created";
  }
  const source = fs.readFileSync(settings, "utf8");
  const found = locate(source, KEY);
  if (found) {
    if (found.value === "true") return "already";
    writeAtomic(settings, source.slice(0, found.valueStart) + "true" + source.slice(found.valueEnd));
    return "enabled";
  }
  if (source.trim() === "") {
    writeAtomic(settings, `{\n  "${KEY}": true\n}\n`);
    return "created";
  }
  const updated = withSetting(source);
  if (!updated) return "failed";
  writeAtomic(settings, updated);
  return "enabled";
}

export function enableTerminalImages(): EditorResult[] {
  return userDirs().map(({ name, dir }) => {
    const settings = path.join(dir, "settings.json");
    try {
      return { name, settings, outcome: applyTo(settings) };
    } catch (error) {
      return {
        name,
        settings,
        outcome: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function setupCommand(): number {
  const results = enableTerminalImages();
  if (results.length === 0) {
    process.stdout.write("no vscode-family editors found\n");
    return 0;
  }
  const turnedOn = results.filter((r) => r.outcome === "enabled" || r.outcome === "created");
  const already = results.filter((r) => r.outcome === "already");
  const failed = results.filter((r) => r.outcome === "failed");
  for (const editor of turnedOn) {
    process.stdout.write(`enabled terminal images in ${editor.name}\n`);
  }
  for (const editor of failed) {
    process.stderr.write(`could not edit ${editor.settings}: ${editor.error ?? "unknown error"}\n`);
  }
  if (turnedOn.length === 0 && failed.length === 0) {
    process.stdout.write(
      `terminal images already enabled in ${already.length} editor${already.length === 1 ? "" : "s"}\n`,
    );
    return 0;
  }
  if (turnedOn.length > 0) {
    process.stdout.write("open a new terminal in those editors to pick it up\n");
  }
  return failed.length > 0 ? 1 : 0;
}

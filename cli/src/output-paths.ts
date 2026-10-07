import path from "node:path";

// agent-browser's daemon writes files relative to wherever the session's first command ran, not the caller.
// The flag lists and the screenshot selector rule mirror agent-browser's argument parser (cli/src/flags.rs).

const VALUE_FLAGS = new Set([
  "--session",
  "--restore-save",
  "--restore-check-url",
  "--restore-check-text",
  "--restore-check-fn",
  "--namespace",
  "--headers",
  "--executable-path",
  "--cdp",
  "--extension",
  "--init-script",
  "--enable",
  "--profile",
  "--state",
  "--proxy",
  "--proxy-bypass",
  "--args",
  "--user-agent",
  "-p",
  "--provider",
  "--device",
  "--session-name",
  "--color-scheme",
  "--download-path",
  "--max-output",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions",
  "--config",
  "--engine",
  "--screenshot-dir",
  "--screenshot-quality",
  "--screenshot-format",
  "--idle-timeout",
  "--model",
]);

const OPTIONAL_BOOLEAN_FLAGS = new Set([
  "--json",
  "--headed",
  "--webgpu",
  "--debug",
  "--ignore-https-errors",
  "--allow-file-access",
  "--hide-scrollbars",
  "--auto-connect",
  "--annotate",
  "--content-boundaries",
  "--confirm-interactive",
  "--no-auto-dialog",
]);

function positionalIndexes(args: string[]): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      i++;
    } else if (OPTIONAL_BOOLEAN_FLAGS.has(arg)) {
      if (args[i + 1] === "true" || args[i + 1] === "false") i++;
    } else if (!arg.startsWith("-")) {
      indexes.push(i);
    }
  }
  return indexes;
}

function looksLikeScreenshotPath(arg: string): boolean {
  const relative = arg.startsWith("./") || arg.startsWith("../");
  if (!relative && (arg.startsWith(".") || arg.startsWith("#") || arg.startsWith("@"))) return false;
  return relative || arg.includes("/") || /\.(png|jpe?g|webp)$/.test(arg);
}

function outputPathIndex(args: string[]): number | null {
  const [command, ...rest] = positionalIndexes(args);
  if (command === undefined) return null;
  if (args[command] === "pdf") return rest[0] ?? null;
  if (args[command] !== "screenshot") return null;
  if (rest.length >= 2) return rest[1];
  if (rest.length === 1 && looksLikeScreenshotPath(args[rest[0]])) return rest[0];
  return null;
}

export function resolveOutputPaths(args: string[], cwd: string): string[] {
  const index = outputPathIndex(args);
  if (index === null) return args;
  const target = args[index];
  if (path.isAbsolute(target) || target.startsWith("~")) return args;
  const resolved = [...args];
  resolved[index] = path.resolve(cwd, target);
  return resolved;
}

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// .claude/types holds the plugin API declarations the plugin's tsconfig includes.
// They are gitignored and tied to the installed Claude Code, so we regenerate
// them here rather than checking them in. Claude Code unpacks them to a temp dir
// when its plugin-authoring skill loads.
const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "claude-code-plugin", ".claude", "types");
const target = path.join(dir, "claude-code.d.ts");

if (process.argv.includes("--if-missing") && fs.existsSync(target)) process.exit(0);

function claudeVersion() {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[0];
  } catch {
    return null;
  }
}

const version = claudeVersion();
if (!version) {
  // fixme: placeholder copy
  process.stderr.write("plugin-types: claude is not on PATH, skipping (run 'pnpm types' once it is installed)\n");
  process.exit(0);
}

spawnSync("claude", ["-p", "/plugin-authoring reply ok", "--max-turns", "1"], {
  stdio: "ignore",
});

const unpacked =
  process.platform === "win32"
    ? path.join(os.tmpdir(), "claude", "bundled-skills", version)
    : path.join("/tmp", `claude-${process.getuid()}`, "bundled-skills", version);

function newestTypes() {
  let entries;
  try {
    entries = fs.readdirSync(unpacked);
  } catch {
    return null;
  }
  return (
    entries
      .map((entry) => path.join(unpacked, entry, "plugin-authoring", "types", "claude-code.d.ts"))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
  );
}

const source = newestTypes();
if (!source) {
  // fixme: placeholder copy
  process.stderr.write(`plugin-types: claude ${version} did not unpack the plugin types, skipping\n`);
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(source, target);

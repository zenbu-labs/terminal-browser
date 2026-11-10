#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import * as prompts from "@clack/prompts";

const packageDir = import.meta.dirname;
const templateDir = path.join(packageDir, "template");
const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));

const DEFAULT_TARGET_DIR = "pixel-app";

const USAGE = `usage: npm create @zenbu-labs/pixel@latest [dir] [-- options]

  Creates a pixel app in [dir]. Without [dir] it asks for a project name; "." uses
  the current directory.

  --overwrite        remove existing files in [dir] (keeps .git)
  --no-install       only write the files
  --no-interactive   never prompt, use defaults
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    overwrite: { type: "boolean" },
    "no-install": { type: "boolean" },
    interactive: { type: "boolean" },
    "no-interactive": { type: "boolean" },
  },
});

if (flags.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const interactive = flags["no-interactive"] ? false : (flags.interactive ?? process.stdin.isTTY === true);

function cancel() {
  prompts.cancel("Operation cancelled");
  process.exit(1);
}

function formatTargetDir(dir) {
  return dir.trim().replace(/[<>:"\\|?*]/g, "").replace(/\/+$/g, "");
}

function isEmpty(dir) {
  const files = fs.readdirSync(dir);
  return files.length === 0 || (files.length === 1 && files[0] === ".git");
}

function emptyDir(dir) {
  for (const file of fs.readdirSync(dir)) {
    if (file === ".git") continue;
    fs.rmSync(path.join(dir, file), { recursive: true, force: true });
  }
}

function isValidPackageName(name) {
  return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(name);
}

function toValidPackageName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^[._]/, "")
    .replace(/[^a-z\d\-~]+/g, "-");
}

function packageManager() {
  const agent = process.env.npm_config_user_agent;
  return agent ? agent.split(" ")[0].split("/")[0] : "npm";
}

function gitInit(root) {
  const git = (...args) => spawnSync("git", args, { cwd: root, stdio: "ignore" }).status === 0;
  if (!git("--version") || git("rev-parse", "--is-inside-work-tree")) return false;
  if (!git("init")) return false;
  const committed =
    git("checkout", "-b", "main") && git("add", "-A") && git("commit", "-m", "Initial commit from create-pixel");
  if (!committed) fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  return committed;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

prompts.intro("create-pixel");

let targetDir = positionals[0] ? formatTargetDir(positionals[0]) : undefined;
if (!targetDir) {
  if (interactive) {
    const answer = await prompts.text({
      message: "Project name:",
      defaultValue: DEFAULT_TARGET_DIR,
      placeholder: DEFAULT_TARGET_DIR,
    });
    if (prompts.isCancel(answer)) cancel();
    targetDir = formatTargetDir(answer) || DEFAULT_TARGET_DIR;
  } else {
    targetDir = DEFAULT_TARGET_DIR;
  }
}

const root = path.resolve(targetDir);

if (fs.existsSync(root) && !isEmpty(root)) {
  let action = flags.overwrite ? "yes" : interactive ? undefined : "no";
  if (!action) {
    const answer = await prompts.select({
      message: `${targetDir === "." ? "Current directory" : `Target directory "${targetDir}"`} is not empty. Please choose how to proceed:`,
      options: [
        { label: "Cancel operation", value: "no" },
        { label: "Remove existing files and continue", value: "yes" },
        { label: "Ignore files and continue", value: "ignore" },
      ],
    });
    if (prompts.isCancel(answer)) cancel();
    action = answer;
  }
  if (action === "no") cancel();
  if (action === "yes") emptyDir(root);
}

const folderName = path.basename(root);
const packageName = isValidPackageName(folderName) ? folderName : toValidPackageName(folderName);

const pm = packageManager();

prompts.log.step(`Scaffolding project in ${root}${packageName === folderName ? "" : ` (package name "${packageName}")`}...`);

const SKIP = new Set(["node_modules", "dist"]);
fs.mkdirSync(root, { recursive: true });
fs.cpSync(templateDir, root, { recursive: true, filter: (source) => !SKIP.has(path.basename(source)) });
fs.renameSync(path.join(root, "gitignore"), path.join(root, ".gitignore"));

const manifestPath = path.join(root, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.name = packageName;
manifest.dependencies["@zenbu-labs/pixel"] = `^${version}`;
manifest.pnpm = { onlyBuiltDependencies: ["@zenbu-labs/pixel"] };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const start = pm === "npm" ? ["run", "start"] : ["start"];

const install = !flags["no-install"];
if (install) {
  prompts.log.step(`Installing dependencies with ${pm}...`);
  run(pm, pm === "npm" ? ["install", "--prefer-online"] : ["install"], root);
}

if (gitInit(root)) prompts.log.step("Initialized a git repository.");

const relative = path.relative(process.cwd(), root);
const steps = [];
if (root !== process.cwd()) steps.push(`cd ${relative.includes(" ") ? `"${relative}"` : relative}`);
if (!install) steps.push(`${pm} install`);
steps.push(`${pm} ${start.join(" ")}`);
prompts.outro(`Done. Now run:\n\n${steps.map((step) => `  ${step}`).join("\n")}`);

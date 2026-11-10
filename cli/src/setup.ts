import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enableTerminalImages } from "./editors";
import { apparmorSetup } from "./sandbox";
import { installedVersion } from "./upgrade";

interface AgentEntry {
  name: string;
  location: string;
  variant: string;
}

interface Manifest {
  agents: AgentEntry[];
  skills: string[];
}

function stateDir(): string {
  const configured = process.env.XDG_STATE_HOME;
  const base = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), ".local", "state");
  return path.join(base, "terminal-browser");
}

function distRoot(): string | null {
  return process.env.TERMINAL_BROWSER_DIST_ROOT ?? null;
}

function readManifest(root: string): Manifest | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(root, "skills", "manifest"), "utf8").split("\n");
  } catch {
    return null;
  }
  const manifest: Manifest = { agents: [], skills: [] };
  for (const line of lines) {
    const [kind, ...rest] = line.split(" ").filter(Boolean);
    if (kind === "agent" && rest.length >= 2) {
      manifest.agents.push({ name: rest[0], location: rest[1], variant: rest[2] ?? "default" });
    }
    if (kind === "skill" && rest[0]) manifest.skills.push(rest[0]);
  }
  return manifest;
}

function isSymlink(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

function exists(file: string): boolean {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

export interface SkillLinks {
  linkedAgents: string[];
  left: string[];
}

export function linkSkills(): SkillLinks {
  const result: SkillLinks = { linkedAgents: [], left: [] };
  const root = distRoot();
  if (!root) return result;
  const manifest = readManifest(root);
  if (!manifest) return result;

  const wrote = new Set<string>();
  const place = (target: string, link: string): boolean => {
    if (exists(link) && !isSymlink(link)) {
      result.left.push(link);
      return false;
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
    wrote.add(link);
    return true;
  };

  for (const agent of manifest.agents) {
    const dir = path.join(os.homedir(), agent.location);
    if (!exists(path.dirname(dir))) continue;
    let made = false;
    for (const skill of manifest.skills) {
      const target = path.join(root, "skills", agent.variant, skill);
      if (!fs.existsSync(target)) continue;
      if (place(target, path.join(dir, skill))) made = true;
    }
    if (made) result.linkedAgents.push(agent.name);
  }

  const shared = process.env.AGENT_SKILLS_HOME ?? path.join(os.homedir(), ".agents", "skills");
  for (const skill of manifest.skills) {
    const target = path.join(root, "skills", "default", skill);
    if (!fs.existsSync(target)) continue;
    const link = path.join(shared, skill);
    if (exists(link) && !isSymlink(link)) {
      fs.rmSync(path.join(link, "SKILL.md"), { force: true });
      try {
        fs.rmdirSync(link);
      } catch {}
    }
    place(target, link);
  }

  for (const link of recordedLinks()) {
    if (wrote.has(link) || !isSymlink(link)) continue;
    const target = fs.readlinkSync(link);
    if (target.startsWith(root + path.sep) || !fs.existsSync(target)) fs.rmSync(link, { force: true });
  }
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(receiptFile(), [...wrote].sort().join("\n") + (wrote.size > 0 ? "\n" : ""));
  return result;
}

function receiptFile(): string {
  return path.join(stateDir(), "skills.links");
}

function recordedLinks(): string[] {
  try {
    return fs.readFileSync(receiptFile(), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function unlinkSkills(): void {
  for (const link of recordedLinks()) {
    if (isSymlink(link)) fs.rmSync(link, { force: true });
  }
  fs.rmSync(receiptFile(), { force: true });
}

function skillChoiceFile(): string {
  return path.join(stateDir(), "skills-choice");
}

function skillsDeclined(): boolean {
  try {
    return fs.readFileSync(skillChoiceFile(), "utf8").trim() === "no";
  } catch {
    return false;
  }
}

function rememberSkillChoice(install: boolean): void {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(skillChoiceFile(), install ? "yes\n" : "no\n");
}

function askOnTerminal(prompt: string): string | null {
  let tty: number;
  try {
    tty = fs.openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    fs.writeSync(tty, prompt);
    const byte = Buffer.alloc(1);
    let line = "";
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(tty, byte, 0, 1, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
        throw error;
      }
      if (read === 0) break;
      const ch = byte.toString();
      if (ch === "\n") break;
      line += ch;
    }
    return line;
  } finally {
    fs.closeSync(tty);
  }
}

function wantsSkill(): boolean {
  const answer = askOnTerminal("Install terminal-browser agent skill (recommended)? [Y/n] ");
  if (answer === null) return true;
  return /^(y|yes|)$/i.test(answer.trim());
}

function marker(): { file: string; want: string } | null {
  const root = distRoot();
  const version = installedVersion();
  if (!root || !version) return null;
  return { file: path.join(stateDir(), "setup-version"), want: `${version} ${root}` };
}

export function markSetupDone(): void {
  const state = marker();
  if (!state) return;
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(state.file, `${state.want}\n`);
}

export function ensureSetup(): void {
  const state = marker();
  if (!state) return;
  try {
    if (fs.readFileSync(state.file, "utf8").trim() === state.want) return;
  } catch {}
  try {
    if (!skillsDeclined()) linkSkills();
    enableTerminalImages();
    markSetupDone();
  } catch {}
}

function reportEditorFailures(): number {
  const failed = enableTerminalImages().filter((editor) => editor.outcome === "failed");
  for (const editor of failed) {
    process.stderr.write(`could not edit ${editor.settings}: ${editor.error ?? "unknown error"}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}

export function setupCommand(electronBinary: string): number {
  const sandbox = apparmorSetup(electronBinary);
  const install = wantsSkill();
  rememberSkillChoice(install);
  if (install) {
    const { linkedAgents } = linkSkills();
    const where = linkedAgents.length > 0 ? `for ${linkedAgents.join(", ")}` : "to ~/.agents/skills";
    process.stdout.write(`installed skill ${where}\n`);
  } else {
    unlinkSkills();
  }
  const editors = reportEditorFailures();
  markSetupDone();
  return editors !== 0 ? editors : sandbox;
}

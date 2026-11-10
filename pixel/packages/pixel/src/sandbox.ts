import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
// probably need app name injection support here
const REFUSAL = `the codex sandbox blocks commands that are needed to determine the terminal pane the command is ran from.]
Re-run this command with escalated permissions.`;

function inCodex(): boolean {
  return Boolean(process.env.CODEX_THREAD_ID ?? process.env.CODEX_PERMISSION_PROFILE);
}

export function sandboxRefusal(): string | null {
  return process.env.CODEX_SANDBOX ? REFUSAL : null;
}

export function deniedRefusal(): string | null {
  return inCodex() ? REFUSAL : null;
}
/**
 * The reason we need to write this file is chromium
 * uses a linux feature (unprivelged user namespaces) 
 * that ubuntu will not let a process use without a specific
 * "grant" (userns) that can be given to a process by making
 * this special file that creates an apparmor profile
 */

const APPARMOR_SCRIPT = path.resolve(__dirname, "..", "scripts", "apparmor.sh");

function kernelSetting(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").trim();
}

function setuidSandbox(electronBinary: string): boolean {
  const helper = path.join(path.dirname(electronBinary), "chrome-sandbox");
  const stat = fs.statSync(helper, { throwIfNoEntry: false });
  return stat !== undefined && stat.uid === 0 && (stat.mode & 0o4000) !== 0;
}

function apparmorProfile(electronBinary: string): boolean {
  try {
    const resolved = fs.realpathSync(electronBinary);
    const slug = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    return fs.readFileSync(`/etc/apparmor.d/pixel-${slug}`, "utf8").includes(resolved);
  } catch {
    return false;
  }
}

export function linuxSandboxError(electronBinary: string): string | null {
  if (process.getuid?.() === 0) {
    return "Linux sandbox cannot run as root. Run pixel as a non-root user.]";
  }
  // look into all these cases some are new 

  if (setuidSandbox(electronBinary)) return null;

  if (apparmorProfile(electronBinary)) return null;

  if (kernelSetting("/proc/sys/user/max_user_namespaces") === "0") {
    return "This machine sets user.max_user_namespaces to 0, so nothing can create the user namespaces the chromium sandbox needs. Raise it with: sudo sysctl -w user.max_user_namespaces=15000 (write it to /etc/sysctl.d/ to keep it across reboots), or install a root-owned setuid chrome-sandbox helper.]";
  }

  if (kernelSetting("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") {
    return "AppArmor blocks unprivileged user namespaces, which the chromium sandbox needs. Run: sudo bash node_modules/@zenbu-labs/pixel/scripts/apparmor.sh <electron binary>]";
  }

  if (kernelSetting("/proc/sys/kernel/unprivileged_userns_clone") === "0") {
    return "Linux disables unprivileged user namespaces. Enable them or install a root-owned setuid chrome-sandbox helper.";
  }

  return null;
}

export function apparmorSetup(electronBinary: string): number {
  if (process.platform !== "linux") return 0;
  try {
    execFileSync("bash", [APPARMOR_SCRIPT, electronBinary], { stdio: "inherit" });
    return 0;
  } catch (error) {
    process.stderr.write(
      `could not install the AppArmor profile: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REFUSAL = `the codex sandbox blocks commands terminal-browser needs to run to determine the terminal pane terminal-browser is running in.
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

const APPARMOR_SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "apparmor.sh");

function kernelSetting(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").trim();
}

function setuidSandbox(electronBinary: string): boolean {
  const helper = path.join(path.dirname(electronBinary), "chrome-sandbox");
  const stat = fs.statSync(helper, { throwIfNoEntry: false });
  return stat !== undefined && stat.uid === 0 && (stat.mode & 0o4000) !== 0;
}

// apparmor.sh names a profile after the path the kernel really runs and deletes it when
// the kernel refuses it, so both sides resolve symlinks first or they read different
// files, and a profile that is there at all is one the kernel took.
function apparmorProfile(electronBinary: string): boolean {
  try {
    const resolved = fs.realpathSync(electronBinary);
    const slug = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    return fs.readFileSync(`/etc/apparmor.d/terminal-browser-${slug}`, "utf8").includes(resolved);
  } catch {
    return false;
  }
}

export function linuxSandboxError(electronBinary: string): string | null {
  if (process.getuid?.() === 0) {
    return "Linux sandbox cannot run as root. Run terminal-browser as a non-root user.";
  }

  if (setuidSandbox(electronBinary)) return null;

  if (apparmorProfile(electronBinary)) return null;

  if (kernelSetting("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") {
    return "AppArmor blocks unprivileged user namespaces, which the chromium sandbox needs. Run: terminal-browser setup";
  }

  if (kernelSetting("/proc/sys/kernel/unprivileged_userns_clone") === "0") {
    return "Linux disables unprivileged user namespaces. Enable them or install a root-owned setuid chrome-sandbox helper.";
  }

  return null;
}

/** Grants the browser user namespaces on distros that gate them behind AppArmor. */
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

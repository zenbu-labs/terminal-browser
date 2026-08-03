import fs from "node:fs";
import path from "node:path";

function kernelSetting(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").trim();
}

export function linuxSandboxError(electronBinary: string): string | null {
  if (process.getuid?.() === 0) {
    return "Linux sandbox cannot run as root. Run terminal-browser as a non-root user.";
  }

  const helper = path.join(path.dirname(electronBinary), "chrome-sandbox");
  const stat = fs.statSync(helper, { throwIfNoEntry: false });
  if (stat && stat.uid === 0 && (stat.mode & 0o4000) !== 0) return null;

  if (kernelSetting("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1") {
    return "AppArmor blocks unprivileged user namespaces. Install an AppArmor profile for terminal-browser.";
  }

  if (kernelSetting("/proc/sys/kernel/unprivileged_userns_clone") === "0") {
    return "Linux disables unprivileged user namespaces. Enable them or install a root-owned setuid chrome-sandbox helper.";
  }

  return null;
}

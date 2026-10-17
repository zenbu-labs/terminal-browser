import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function inTermux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TERMUX_VERSION) || (env.PREFIX ?? "").startsWith("/data/data/com.termux/");
}

// Android apps get no root-owned sandbox helper, no user namespaces, no /dev/shm and no GPU chromium can use.
export const TERMUX_CHROMIUM_FLAGS = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

export function termuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prefix = env.PREFIX ?? "/data/data/com.termux/files/usr";
  const fonts = path.join(prefix, "glibc", "etc", "fonts", "fonts.conf");
  return {
    ...env,
    TMPDIR: env.TMPDIR ?? path.join(prefix, "tmp"),
    FONTCONFIG_FILE: env.FONTCONFIG_FILE ?? (fs.existsSync(fonts) ? fonts : undefined),
    PULSE_SERVER: env.PULSE_SERVER ?? termuxPulseServer(),
  };
}

// Termux's pulseaudio puts its socket in a random directory that electron's glibc libpulse cannot find on its own.
function termuxPulseServer(): string | undefined {
  const info = () => spawnSync("pactl", ["info"], { encoding: "utf8" });
  let result = info();
  if (result.status !== 0) {
    spawnSync("pulseaudio", ["--start"]);
    result = info();
  }
  const socket = /^Server String: (.+)$/m.exec(result.stdout ?? "")?.[1];
  return socket ? `unix:${socket}` : undefined;
}

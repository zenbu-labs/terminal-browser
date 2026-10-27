import { execFileSync } from "node:child_process";
import path from "node:path";

export function appExecutable(app: string): string {
  if (!app.endsWith(".app")) return app;
  const plist = path.join(app, "Contents", "Info.plist");
  let name: string;
  try {
    name = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist], {
      encoding: "utf8",
    }).trim();
  } catch {
    // fixme: placeholder copy
    throw new Error(`${plist} has no CFBundleExecutable`);
  }
  return path.join(app, "Contents", "MacOS", name);
}

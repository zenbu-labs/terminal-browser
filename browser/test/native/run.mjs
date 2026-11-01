// Runs every *.probe.cjs against pixel's patched Electron, each in a fresh profile.
//   PIXEL_ELECTRON_APP=~/electron-dev/src/out/Testing/Electron.app node browser/test/native/run.mjs [name...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const appPath = process.env.PIXEL_ELECTRON_APP;
if (!appPath) {
  // fixme: placeholder copy
  console.error("Set PIXEL_ELECTRON_APP to the patched Electron.app (or its binary).");
  process.exit(2);
}
const binary = appPath.endsWith(".app") ? path.join(appPath, "Contents/MacOS/Electron") : appPath;
const only = process.argv.slice(2);
const probes = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".probe.cjs"))
  .filter((f) => !only.length || only.some((o) => f.startsWith(o)));

function launch(file, profile, phase) {
  return new Promise((resolve) => {
    const env = { ...process.env, PROBE_PROFILE: profile, PROBE_PHASE: String(phase) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(binary, [path.join(dir, file)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let log = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (log += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, log });
    });
  });
}

let failed = 0;
for (const file of probes) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tb-native-probe-"));
  let result;
  for (let phase = 1; phase <= 5; phase++) {
    result = await launch(file, profile, phase);
    if (!result.out.includes("PROBE NEXT")) break;
  }
  const line = result.out.split("\n").filter((l) => l.startsWith("PROBE ") || l.startsWith("  ")).join("\n");
  const crash = result.log.match(/FATAL:[^\n]*|Received signal[^\n]*/)?.[0];
  if (result.code === 0 && !crash && line.includes("PROBE PASS")) {
    console.log(line);
    fs.rmSync(profile, { recursive: true, force: true });
  } else {
    failed++;
    console.log(line || `PROBE FAIL ${file}: exit ${result.code ?? result.signal}`);
    if (crash) console.log(`  crashed: ${crash}`);
    console.log(`  profile kept at ${profile}`);
  }
}
process.exit(failed ? 1 : 0);

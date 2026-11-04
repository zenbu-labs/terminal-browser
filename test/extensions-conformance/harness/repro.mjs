// Loads each crash repro extension alone in a fresh terminal-browser and
// reports whether the browser process survived.
import fs from "node:fs";
import path from "node:path";
import { tbDriver, sleep } from "./drivers.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../extensions");

export async function runRepros({ binary, out, names = [], log = console.error }) {
  const list = names.length ? names : fs.readdirSync(ROOT).filter((n) => n.startsWith("repro-"));
  const report = [];
  for (const name of list) {
    const dir = path.join(out, name);
    let d = null, startError = null;
    try {
      d = await tbDriver({ electron: binary, extensions: [path.join(ROOT, name)], startUrl: "about:blank", label: name, out: dir });
      await sleep(6000);
    } catch (error) {
      startError = error.message;
    }
    const daemonLog = fs.readFileSync(path.join(dir, "daemon.log"), "utf8");
    const crash = daemonLog.match(/FATAL:[^\n]+|Received signal \d+[^\n]*|TypeError: Object has been destroyed/)?.[0] ?? null;
    report.push({ name, survived: !crash && !startError, crash, startError, log: path.join(dir, "daemon.log") });
    log(JSON.stringify(report.at(-1)));
    await d?.stop().catch(() => {});
  }
  return report;
}

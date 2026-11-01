// Loads each crash repro extension alone in a fresh terminal-browser and
// reports whether the browser process survived.
//   node repro.mjs [name...]
import fs from "node:fs";
import path from "node:path";
import { tbDriver, sleep } from "./drivers.mjs";
import { OUT } from "./tb.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../extensions");
const names = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(ROOT).filter((n) => n.startsWith("repro-"));
fs.mkdirSync(path.join(OUT, "profiles"), { recursive: true });
const report = [];
for (const name of names) {
  const out = path.join(OUT, "runs", `${name}-${Date.now()}`);
  let d = null, startError = null;
  try {
    d = await tbDriver({ extensions: [path.join(ROOT, name)], startUrl: "about:blank", label: name, out });
    await sleep(6000);
  } catch (error) {
    startError = error.message;
  }
  const log = fs.readFileSync(path.join(out, "daemon.log"), "utf8");
  const crash = log.match(/FATAL:[^\n]+|Received signal \d+[^\n]*|TypeError: Object has been destroyed/)?.[0] ?? null;
  const frame = crash ? log.slice(log.indexOf(crash)).split("\n").find((l) => /^\s*\d+\s+Electron Framework .*(extensions|storage_monitor|Permissions)/.test(l))?.replace(/^\s*\d+\s+Electron Framework\s+0x[0-9a-f]+\s+/, "") ?? null : null;
  report.push({ name, survived: !crash, crash, frame, startError, log: path.join(out, "daemon.log") });
  console.log(JSON.stringify(report.at(-1)));
  await d?.stop().catch(() => {});
}
fs.writeFileSync(path.join(OUT, "repro.json"), JSON.stringify(report, null, 1));

#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromeForTesting, CHROME_VERSION } from "./harness/cft.mjs";
import { compareRun } from "./harness/compare.mjs";
import { buildReference, EXPECTATIONS_FILE, readJson, REFERENCE_FILE } from "./harness/reference.mjs";
import { renderReport } from "./harness/report.mjs";
import { runRepros } from "./harness/repro.mjs";
import { runSuite } from "./harness/suite.mjs";
import { REPO } from "./harness/tb.mjs";

// fixme: placeholder copy
const HELP = `Chrome extension conformance: runs the God extension self-test in terminal-browser and compares it with Chrome ${CHROME_VERSION}.

Usage:
  conformance.mjs run [--electron <bin>] [--out <dir>] [--only <regex>] [--video]
      Run the self-test in terminal-browser and compare. Exits 1 on any regression.
  conformance.mjs compare <results-tb.json> [--out <dir>]
      Compare an existing terminal-browser run.
  conformance.mjs chrome-reference [--chrome <bin>] [--runs <n>] [--from <dir>]
      Regenerate chrome-reference.json from Chrome for Testing ${CHROME_VERSION} (downloaded if missing).
  conformance.mjs repro [--electron <bin>] [--out <dir>] [name...]
      Load each crash repro extension alone and report whether the browser survived.

Options:
  --electron <bin>   Electron binary (default: TB_ELECTRON, else pixel's installed Electron)
  --chrome <bin>     Chrome binary (default: CFT_CHROME, else the cached Chrome for Testing)
  --out <dir>        Output directory (default: a new temp directory)
  --runs <n>         Chrome runs to fold into the reference (default 3)
  --from <dir>       Rebuild the reference from the Chrome results an earlier chrome-reference --out <dir> kept
  --only <regex>     Only run service worker checks whose id matches
  --video            Record the terminal-browser run
  -h, --help         Show this help`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    electron: { type: "string" },
    chrome: { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "3" },
    from: { type: "string" },
    only: { type: "string" },
    video: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [command, ...rest] = positionals;
if (opts.help || !command) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 1);
}

const out = path.resolve(opts.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "tb-conformance-")));
fs.mkdirSync(out, { recursive: true });
const electron = opts.electron ?? process.env.TB_ELECTRON ?? path.join(REPO, "pixel/packages/pixel/electron/dist/Electron.app/Contents/MacOS/pixel");
const expectations = readJson(EXPECTATIONS_FILE);
const notRun = Object.entries(expectations.notRun ?? {});
const write = (name, data) => fs.writeFileSync(path.join(out, name), typeof data === "string" ? data : JSON.stringify(data, null, 1));

function compareAndReport(tb) {
  const reference = readJson(REFERENCE_FILE);
  const result = compareRun({ reference, tb, expectations });
  write("verdicts.json", { at: tb.at, chrome: reference.chrome, ...result });
  const shown = (rows) => rows.map((r) => (r.expected ? { ...r, verdict: "expected", why: `${r.verdict}, ${r.expected.kind}: ${r.expected.reason}` } : r));
  write("report.html", renderReport({ at: tb.at, chrome: reference.chrome, rows: shown(result.rows), surfaceRows: shown(result.surfaceRows), extras: { video: tb.extras?.video ? path.relative(out, tb.extras.video) : null } }));
  const count = (list) => list.reduce((m, r) => ((m[r.expected ? `${r.verdict} (expected)` : r.verdict] = (m[r.expected ? `${r.verdict} (expected)` : r.verdict] ?? 0) + 1), m), {});
  // fixme: placeholder copy
  console.log(`checks ${JSON.stringify(count(result.rows))}`);
  console.log(`surface ${JSON.stringify(count(result.surfaceRows))}`);
  const securityExpected = result.rows.filter((r) => r.security && r.expected);
  // fixme: placeholder copy
  if (securityExpected.length) console.log(`security checks expected to differ (expectations.json): ${securityExpected.map((r) => r.key).join(", ")}`);
  for (const r of result.regressions) {
    const chrome = r.chrome == null ? "-" : Array.isArray(r.chrome) ? r.chrome.map((o) => `${o.ok ? "" : "✗ "}${o.sig}`).join(" | ") : r.chrome;
    const tbSig = r.tb == null ? "-" : typeof r.tb === "string" ? r.tb : `${r.tb.ok ? "" : "✗ "}${r.tb.sig}`;
    // fixme: placeholder copy
    console.log(`REGRESSION ${r.verdict}${r.security ? " [security]" : ""} ${r.key}: ${r.why ?? ""}\n  chrome: ${chrome}\n  tb:     ${tbSig}`);
  }
  // fixme: placeholder copy
  for (const k of result.stale) console.log(`STALE expectation ${k}: passes now (or no longer exists); remove it from expectations.json`);
  // fixme: placeholder copy
  console.log(`report: ${path.join(out, "report.html")}`);
  return result.regressions.length || result.stale.length ? 1 : 0;
}

if (command === "run") {
  const tb = await runSuite({ which: "tb", binary: electron, out, only: opts.only, video: opts.video, notRun });
  write("results-tb.json", tb);
  process.exitCode = compareAndReport(tb);
} else if (command === "compare") {
  // fixme: placeholder copy
  if (!rest[0]) throw new Error("compare needs a results-tb.json path");
  process.exitCode = compareAndReport(readJson(rest[0]));
} else if (command === "chrome-reference") {
  const runs = opts.from ? fs.readdirSync(opts.from).filter((f) => /^results-chrome-\d+\.json$/.test(f)).map((f) => readJson(path.join(opts.from, f))) : [];
  const binary = opts.from ? null : opts.chrome ?? (await chromeForTesting(console.error));
  for (let i = 0; !opts.from && i < Number(opts.runs); i++) {
    const run = await runSuite({ which: "chrome", binary, out: path.join(out, `chrome-${i}`) });
    write(`results-chrome-${i}.json`, run);
    // fixme: placeholder copy
    if (run.results.some((r) => r.ctx === "harness")) throw new Error(`Chrome run ${i} failed: ${JSON.stringify(run.results.filter((r) => r.ctx === "harness"))}`);
    runs.push(run);
  }
  const version = runs[0].extras.version;
  // fixme: placeholder copy
  if (version !== CHROME_VERSION) throw new Error(`expected Chrome ${CHROME_VERSION}, got ${version}`);
  const reference = buildReference(runs, version);
  fs.writeFileSync(REFERENCE_FILE, JSON.stringify(reference, null, 1) + "\n");
  const unstable = Object.entries(reference.checks).filter(([, o]) => o.length > 1).map(([k]) => k);
  // fixme: placeholder copy
  console.log(`wrote ${REFERENCE_FILE}: ${Object.keys(reference.checks).length} checks, ${unstable.length} vary between Chrome runs${unstable.length ? `: ${unstable.join(", ")}` : ""}`);
} else if (command === "repro") {
  const report = await runRepros({ binary: electron, out, names: rest });
  write("repro.json", report);
  process.exitCode = report.every((r) => r.survived) ? 0 : 1;
} else {
  console.error(HELP);
  process.exitCode = 1;
}

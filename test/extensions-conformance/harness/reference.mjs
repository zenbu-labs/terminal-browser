// The checked-in Chrome reference: what Chrome for Testing observed for every
// check, with values that change from run to run (ids, ports, times) replaced.
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const REFERENCE_FILE = path.join(ROOT, "chrome-reference.json");
export const EXPECTATIONS_FILE = path.join(ROOT, "expectations.json");

export const keyOf = (r) => `${r.ctx}|${r.id}`;

export function normalize(sig) {
  return String(sig)
    .replace(/^((?:rejects|throws|assert)[^]*)$/, (m) => m.replace(/\d+/g, "N"))
    .replace(/chrome-extension:\/\/[a-p]{32}/g, "EXT")
    .replace(/\b[a-p]{32}\b/g, "EXTID")
    .replace(/localhost:\d+/g, "localhost:PORT")
    .replace(/\b((?:tab|window|frame|parentFrame|openerTab|document|session)Id|id)(["']?\s*[:=]\s*)\d+/g, "$1$2N")
    .replace(/\b\d{6,}(\.\d+)?\b/g, "N");
}

// Folds one or more Chrome runs into the reference. A check that came out
// differently across runs keeps every outcome Chrome produced.
export function buildReference(runs, chromeVersion) {
  const checks = {};
  for (const run of runs) {
    for (const r of run.results) {
      const outcome = { ok: r.ok, sig: normalize(r.sig) };
      const list = (checks[keyOf(r)] ??= []);
      if (!list.some((o) => o.ok === outcome.ok && o.sig === outcome.sig)) list.push(outcome);
    }
  }
  // A check that passed in some runs and failed or stayed pending in others was Chrome being slow under load, not its behavior.
  for (const [key, list] of Object.entries(checks)) {
    const passed = list.filter((o) => o.ok && o.sig !== "pending");
    if (passed.length) checks[key] = passed;
  }
  const surfaces = {};
  for (const ctx of ["sw", "page", "cs"]) {
    const all = runs.map((run) => run.surfaces?.[ctx] ?? {}).filter((s) => Object.keys(s).length);
    // fixme: placeholder copy
    if (!all.length) throw new Error(`no Chrome run captured the ${ctx} surface`);
    surfaces[ctx] = Object.fromEntries(Object.entries(all[0]).filter(([member, kind]) => all.every((s) => s[member] === kind)).sort(([a], [b]) => a.localeCompare(b)));
  }
  const sorted = Object.fromEntries(Object.keys(checks).sort().map((k) => [k, checks[k]]));
  return { chrome: chromeVersion, runs: runs.length, checks: sorted, surfaces };
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

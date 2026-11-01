// Compares results-tb.json against results-chrome.json (the reference) and
// writes verdicts.json + report.html.
//   node compare.mjs [outDir]
import fs from "node:fs";
import path from "node:path";
import { OUT } from "./tb.mjs";
import { CATALOG, namespaceOf } from "./catalog.mjs";
import { renderReport } from "./report.mjs";
import { BUGS } from "./bugs.mjs";

const dir = process.argv[2] ?? OUT;
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const chrome = read("results-chrome.json");
const tb = read("results-tb.json");

const key = (r) => `${r.ctx}|${r.id}`;
const byKey = (list) => new Map(list.map((r) => [key(r), r]));
const C = byKey(chrome.results), T = byKey(tb.results);

const MISSING = /is not a function|Cannot read properties of undefined|undefined is not an object|is not defined|event missing|missing$/;
const normalize = (s) => String(s)
  .replace(/^((?:rejects|throws|assert)[^]*)$/, (m) => m.replace(/\d+/g, "N"))
  .replace(/chrome-extension:\/\/[a-p]{32}/g, "EXT")
  .replace(/localhost:\d+/g, "localhost:PORT")
  .replace(/\b\d{6,}\b/g, "N");

const DOCUMENTED = new Set(["unsupported", "stubbed", "not-on-stable", "chromeos"]);

// Namespace lists differ wherever a namespace is documented as unsupported; only undocumented gaps count.
function compareNamespaces(c, t) {
  const cs = new Set(c.sig.split(",")), ts = new Set(t.sig.split(","));
  const missing = [...cs].filter((n) => !ts.has(n) && !["csi", "loadTimes"].includes(n) && !DOCUMENTED.has(CATALOG[n]?.support));
  const extra = [...ts].filter((n) => !cs.has(n));
  if (!missing.length && !extra.length) return { verdict: "pass", why: "only documented-unsupported namespaces missing" };
  return { verdict: "differs", why: `undocumented missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}` };
}

// The harness seeds terminal-browser's profile before launch (like a restart),
// while Chrome loads the extension fresh, so these can't be compared.
const NOT_COMPARABLE = { "runtime.onInstalled": "harness pre-installs the extension in terminal-browser (restart), Chrome gets a fresh install", "runtime.onStartup": "same as runtime.onInstalled" };

function verdictFor(c, t, ns, id) {
  if (NOT_COMPARABLE[id]) return { verdict: "unsupported", why: `not comparable: ${NOT_COMPARABLE[id]}` };
  const support = CATALOG[ns]?.support ?? "unknown";
  const documented = DOCUMENTED.has(support);
  if (c?.ok && t?.ok && id.endsWith("chrome-namespaces")) return compareNamespaces(c, t);
  if (!t) return { verdict: documented ? "unsupported" : "fails", why: "no result from terminal-browser (context never ran)" };
  if (t.sig.startsWith("crashes:")) return { verdict: "crashes", why: t.sig.slice(9) };
  if (t.sig.startsWith("fails:")) return { verdict: "fails", why: t.sig.slice(7) };
  if (/timeout/.test(t.sig) && !(c && /timeout/.test(c.sig))) return { verdict: documented ? "unsupported" : "fails", why: "hangs (timed out)" };
  if (!c) return { verdict: t.ok ? "pass" : "fails", why: "no Chrome reference for this check" };
  const same = normalize(c.sig) === normalize(t.sig);
  if (c.ok && t.ok) return same ? { verdict: "pass" } : { verdict: documented ? "unsupported" : "differs", why: "different result" };
  if (c.ok && !t.ok) return { verdict: documented ? "unsupported" : MISSING.test(t.note) ? "fails" : "fails", why: MISSING.test(t.note) ? "API missing" : "check fails" };
  if (!c.ok && t.ok && /event did not fire|timeout/.test(c.sig)) return { verdict: "pass", why: "headless Chrome didn't produce this event; terminal-browser meets the documented contract" };
  if (!c.ok && t.ok) return { verdict: documented ? "unsupported" : "differs", why: "Chrome fails this check, terminal-browser does not" };
  return same ? { verdict: "pass", why: "both fail the same way" } : { verdict: documented ? "unsupported" : "differs", why: "both fail, differently" };
}

const keys = [...new Set([...C.keys(), ...T.keys()])];
const rows = keys.map((k) => {
  const c = C.get(k), t = T.get(k);
  const r = c ?? t;
  const ns = namespaceOf(r.id, r.ctx);
  return { id: r.id, ctx: r.ctx, ns, chrome: c ?? null, tb: t ?? null, ...verdictFor(c, t, ns, r.id) };
});

const crashed = tb.extras?.crash;
if (crashed) rows.push({ id: "browser.crash", ctx: "harness", ns: "harness", chrome: null, tb: { ok: false, sig: crashed }, verdict: "crashes", why: crashed });

// Members Chrome exposes that the functional checks didn't name are still
// checked for presence, per context.
const surfaceRows = [];
for (const ctx of ["sw", "page", "cs"]) {
  const cs = chrome.surfaces?.[ctx] ?? {}, ts = tb.surfaces?.[ctx] ?? {};
  for (const [member, kind] of Object.entries(cs)) {
    if (kind === "namespace" || kind === "object" || kind === "enum" || member.startsWith("loadTimes") || member.startsWith("csi")) continue;
    const ns = namespaceOf(member, ctx);
    const support = CATALOG[ns]?.support ?? "unknown";
    const present = member in ts;
    const kindMatch = ts[member] === kind;
    const verdict = present && kindMatch ? "pass" : DOCUMENTED.has(support) ? "unsupported" : present ? "differs" : "fails";
    surfaceRows.push({ id: member, ctx, ns, kind, chrome: kind, tb: ts[member] ?? "missing", verdict, why: present ? (kindMatch ? "" : `kind ${ts[member]}`) : "missing" });
  }
  for (const [member, kind] of Object.entries(ts)) {
    if (member in cs || kind === "namespace" || kind === "object" || kind === "enum") continue;
    surfaceRows.push({ id: member, ctx, ns: namespaceOf(member, ctx), kind, chrome: "missing", tb: kind, verdict: "differs", why: "exposed by terminal-browser but not Chrome" });
  }
}

const video = process.env.GOD_VIDEO ?? (fs.existsSync(path.join(dir, "god-selftest.mp4")) ? "god-selftest.mp4" : null);
const out = { at: new Date().toISOString(), chromeAt: chrome.at, tbAt: tb.at, rows, surfaceRows, bugs: BUGS, extras: { video, tb: tb.extras, chrome: chrome.extras } };
fs.writeFileSync(path.join(dir, "verdicts.json"), JSON.stringify(out, null, 1));
const poster = fs.existsSync(path.join(dir, "god-selftest-poster.png")) ? "god-selftest-poster.png" : null;
fs.writeFileSync(path.join(dir, "report.html"), renderReport({ ...out, extras: { video, poster } }));
const count = (list) => list.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {});
console.log("checks", JSON.stringify(count(rows)), "surface", JSON.stringify(count(surfaceRows)));

// Compares a terminal-browser run against the Chrome reference. Every check
// that differs from Chrome is a regression unless expectations.json lists it.
import { namespaceOf } from "./catalog.mjs";
import { keyOf, normalize } from "./reference.mjs";

// The harness seeds terminal-browser's profile before launch (like a restart),
// while Chrome loads the extension fresh, so these can't be compared.
const NOT_COMPARABLE = { "runtime.onInstalled": "harness pre-installs the extension in terminal-browser (restart), Chrome gets a fresh install", "runtime.onStartup": "same as runtime.onInstalled" };

// Permission gating, page-to-extension messaging and user-gesture requirements.
// These may never be listed as unsupported.
export const isSecurity = (r) => r.ctx === "noperm" || r.ctx === "web" || /^gating\.|^web_accessible_resources|#no-gesture$|-needs-permission$/.test(r.id);

function compareNamespaces(chrome, tb, unsupported) {
  const cs = new Set(chrome.split(",")), ts = new Set(tb.split(","));
  const missing = [...cs].filter((n) => !ts.has(n) && !["csi", "loadTimes"].includes(n) && !unsupported[n]);
  const extra = [...ts].filter((n) => !cs.has(n));
  if (!missing.length && !extra.length) return { verdict: "pass", why: "only unsupported namespaces missing" };
  return { verdict: "differs", why: `missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}` };
}

function verdictFor(outcomes, t, id, unsupported) {
  if (NOT_COMPARABLE[id]) return { verdict: "pass", why: `not comparable: ${NOT_COMPARABLE[id]}` };
  if (!t) return { verdict: "fails", why: "no result from terminal-browser (context never ran)" };
  if (t.sig.startsWith("not-run:")) return { verdict: "fails", why: t.sig };
  if (!outcomes) return t.ok ? { verdict: "pass", why: "no Chrome reference for this check" } : { verdict: "fails", why: "fails, no Chrome reference" };
  if (t.ok && id.endsWith("chrome-namespaces") && outcomes.every((o) => o.ok)) return compareNamespaces(outcomes[0].sig, t.sig, unsupported);
  const sig = normalize(t.sig);
  if (outcomes.some((o) => o.ok === t.ok && o.sig === sig)) return { verdict: "pass" };
  if (t.ok && outcomes.every((o) => !o.ok && /event did not fire|timeout/.test(o.sig))) return { verdict: "pass", why: "headless Chrome didn't produce this event; terminal-browser meets the documented contract" };
  if (/timeout/.test(t.sig)) return { verdict: "fails", why: "hangs (timed out)" };
  if (!t.ok && outcomes.some((o) => o.ok)) return { verdict: "fails", why: "check fails" };
  return { verdict: "differs", why: "different result" };
}

export function compareRun({ reference, tb, expectations }) {
  const unsupported = expectations.unsupported ?? {};
  const knownDiffers = expectations.knownDiffers ?? {};
  const T = new Map(tb.results.map((r) => [keyOf(r), r]));
  const keys = [...new Set([...Object.keys(reference.checks), ...T.keys()])].sort();
  const expectation = (row) => {
    if (knownDiffers[row.key]) return { kind: "known-differs", reason: knownDiffers[row.key] };
    if (row.tb?.sig?.startsWith("not-run:")) return { kind: "not-run", reason: row.tb.sig.slice(9) };
    if (isSecurity(row)) return null;
    const reason = unsupported[row.key] ?? unsupported[row.ns];
    return reason ? { kind: "unsupported", reason } : null;
  };

  const rows = keys.map((key) => {
    const outcomes = reference.checks[key];
    const t = T.get(key) ?? null;
    const [ctx, ...rest] = key.split("|");
    const id = rest.join("|");
    const row = { key, id, ctx, ns: namespaceOf(id, ctx), chrome: outcomes ?? null, tb: t, ...verdictFor(outcomes, t, id, unsupported) };
    row.security = isSecurity(row);
    if (row.verdict !== "pass") row.expected = expectation(row);
    return row;
  });
  if (tb.extras?.crash) rows.push({ key: "harness|browser.crash", id: "browser.crash", ctx: "harness", ns: "harness", chrome: null, tb: { ok: false, sig: tb.extras.crash }, verdict: "crashes", why: tb.extras.crash, security: false, expected: null });

  const surfaceRows = [];
  for (const ctx of ["sw", "page", "cs"]) {
    const cs = reference.surfaces?.[ctx] ?? {}, ts = tb.surfaces?.[ctx] ?? {};
    const skip = (member, kind) => kind === "namespace" || kind === "object" || kind === "enum" || member.startsWith("loadTimes") || member.startsWith("csi");
    for (const [member, kind] of Object.entries(cs)) {
      if (skip(member, kind)) continue;
      const verdict = ts[member] === kind ? "pass" : member in ts ? "differs" : "fails";
      surfaceRows.push({ key: `surface:${ctx}|${member}`, id: member, ctx, ns: namespaceOf(member, ctx), chrome: kind, tb: ts[member] ?? "missing", verdict, why: verdict === "pass" ? "" : member in ts ? `kind ${ts[member]}` : "missing" });
    }
    for (const [member, kind] of Object.entries(ts)) {
      if (member in cs || skip(member, kind)) continue;
      surfaceRows.push({ key: `surface:${ctx}|${member}`, id: member, ctx, ns: namespaceOf(member, ctx), chrome: "missing", tb: kind, verdict: "differs", why: "exposed by terminal-browser but not Chrome" });
    }
  }
  for (const row of surfaceRows) if (row.verdict !== "pass") row.expected = expectation(row);

  const all = [...rows, ...surfaceRows];
  const regressions = all.filter((r) => r.verdict !== "pass" && !r.expected);
  const passing = new Set(all.filter((r) => r.verdict === "pass").map((r) => r.key));
  const stale = Object.keys(knownDiffers).filter((k) => passing.has(k) || !all.some((r) => r.key === k));
  return { rows, surfaceRows, regressions, stale };
}

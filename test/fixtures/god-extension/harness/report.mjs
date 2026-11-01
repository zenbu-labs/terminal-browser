// Renders verdicts into one self-contained, phone-first HTML page.
import { CATALOG } from "./catalog.mjs";

const RANK = { crashes: 0, fails: 1, differs: 2, unsupported: 3, pass: 4 };
const LABEL = { crashes: "crashes", fails: "fails", differs: "differs from Chrome", unsupported: "documented unsupported", pass: "pass" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (s, n = 220) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const sig = (r) => (r == null ? "—" : typeof r === "string" ? r : `${r.ok ? "" : "✗ "}${r.sig}`);

function counts(rows) {
  const c = { crashes: 0, fails: 0, differs: 0, unsupported: 0, pass: 0 };
  for (const r of rows) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return c;
}

function group(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.ns)) by.set(r.ns, []);
    by.get(r.ns).push(r);
  }
  return [...by.entries()]
    .map(([ns, list]) => ({ ns, list: list.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || a.id.localeCompare(b.id)), c: counts(list) }))
    .sort((a, b) => Math.min(...a.list.map((r) => RANK[r.verdict])) - Math.min(...b.list.map((r) => RANK[r.verdict])) || (b.c.crashes + b.c.fails + b.c.differs) - (a.c.crashes + a.c.fails + a.c.differs) || a.ns.localeCompare(b.ns));
}

function pills(c) {
  return Object.keys(RANK).filter((k) => c[k]).map((k) => `<span class="pill ${k}">${c[k]}</span>`).join("");
}

function checkRow(r) {
  const ctx = r.ctx && r.ctx !== "sw" ? `<span class="ctx">${esc(r.ctx)}</span>` : "";
  return `<li class="row ${r.verdict}">
  <div class="head"><span class="v ${r.verdict}">${esc(LABEL[r.verdict])}</span><code>${esc(r.id)}</code>${ctx}</div>
  ${r.verdict === "pass" && !r.why ? `<div class="obs">${esc(short(sig(r.tb), 140))}</div>` : `
  <dl>
    <dt>Chrome</dt><dd>${esc(short(sig(r.chrome)))}</dd>
    <dt>ours</dt><dd>${esc(short(sig(r.tb)))}</dd>
    ${r.why ? `<dt>note</dt><dd>${esc(r.why)}</dd>` : ""}
  </dl>`}
</li>`;
}

export function renderReport({ at, rows, surfaceRows, bugs = [], extras = {} }) {
  const c = counts(rows), sc = counts(surfaceRows);
  const groups = group(rows);
  const surfaceGroups = group(surfaceRows.filter((r) => r.verdict !== "pass"));
  const surfacePass = surfaceRows.filter((r) => r.verdict === "pass").length;
  const video = extras.video ? `<section class="card"><h2>Self-test running in terminal-browser</h2><video src="${esc(extras.video)}"${extras.poster ? ` poster="${esc(extras.poster)}"` : ""} controls playsinline muted preload="metadata"></video></section>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>God Extension: terminal-browser vs Chrome</title>
<style>
:root { --bg: #0e0f12; --card: #17191e; --line: #272a33; --fg: #ececee; --dim: #9094a0; --pass: #3fb950; --fails: #f85149; --crashes: #ff7b72; --differs: #d29922; --unsupported: #8b949e; }
@media (prefers-color-scheme: light) { :root { --bg: #f6f6f8; --card: #fff; --line: #e3e4e8; --fg: #1b1c20; --dim: #63666f; --pass: #1a7f37; --fails: #cf222e; --crashes: #a40e26; --differs: #9a6700; --unsupported: #6e7781; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; overflow-wrap: anywhere; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; padding: env(safe-area-inset-top) env(safe-area-inset-right) calc(env(safe-area-inset-bottom) + 24px) env(safe-area-inset-left); }
header { padding: 20px 16px 8px; }
h1 { font-size: 22px; margin: 0 0 4px; line-height: 1.2; }
.sub { color: var(--dim); font-size: 14px; }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 12px 16px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
.tile b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; line-height: 1.1; }
.tile span { color: var(--dim); font-size: 13px; }
.tile.pass b { color: var(--pass); } .tile.fails b { color: var(--fails); } .tile.crashes b { color: var(--crashes); } .tile.differs b { color: var(--differs); } .tile.unsupported b { color: var(--unsupported); }
.card { min-width: 0; margin: 12px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
.card h2 { margin: 0 0 10px; font-size: 17px; }
video { width: 100%; border-radius: 10px; background: #000; }
.bugs ol { margin: 0; padding-left: 22px; }
.bugs li { margin: 0 0 12px; }
.bugs li b { display: block; }
.bugs small { color: var(--dim); display: block; font-size: 14px; }
h3.section { margin: 22px 16px 6px; font-size: 15px; color: var(--dim); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
details { margin: 8px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
summary { list-style: none; display: flex; align-items: center; gap: 8px; padding: 14px; min-height: 52px; cursor: pointer; font-weight: 600; }
summary::-webkit-details-marker { display: none; }
summary .ns { flex: 1; min-width: 0; overflow-wrap: anywhere; }
summary .ns small { display: block; color: var(--dim); font-weight: 400; font-size: 13px; }
summary::after { content: "›"; color: var(--dim); font-size: 22px; transition: transform .15s; }
details[open] summary::after { transform: rotate(90deg); }
.pill { font-size: 13px; font-weight: 700; padding: 2px 8px; border-radius: 99px; color: #fff; font-variant-numeric: tabular-nums; }
.pill.pass { background: var(--pass); } .pill.fails { background: var(--fails); } .pill.crashes { background: var(--crashes); } .pill.differs { background: var(--differs); } .pill.unsupported { background: var(--unsupported); }
ul { list-style: none; margin: 0; padding: 0; }
.row { border-top: 1px solid var(--line); padding: 10px 14px; }
.head { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: baseline; }
.head code { font: 14px/1.4 ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
.ctx { font-size: 12px; color: var(--dim); border: 1px solid var(--line); border-radius: 6px; padding: 0 5px; }
.v { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
.v.pass { color: var(--pass); } .v.fails { color: var(--fails); } .v.crashes { color: var(--crashes); } .v.differs { color: var(--differs); } .v.unsupported { color: var(--unsupported); }
.obs { color: var(--dim); font: 13px/1.4 ui-monospace, Menlo, monospace; margin-top: 4px; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 8px 0 0; font-size: 14px; }
dt { color: var(--dim); }
dd { margin: 0; font: 13px/1.45 ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
.filters { display: flex; gap: 8px; padding: 4px 16px; overflow-x: auto; }
.filters button { flex: none; font: inherit; font-size: 15px; min-height: 44px; padding: 0 14px; border-radius: 99px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
.filters button[aria-pressed="true"] { background: var(--fg); color: var(--bg); }
body.hide-pass .row.pass, body.hide-pass details.all-pass { display: none; }
@media (min-width: 760px) { .tiles { grid-template-columns: repeat(6, minmax(0, 1fr)); } body { max-width: 980px; margin: 0 auto; } }
</style>
</head>
<body class="hide-pass">
<header>
  <h1>God Extension: terminal-browser vs Chrome</h1>
  <div class="sub">PR #237 (ext/chrome-extensions) vs Chrome for Testing 156 · ${esc(at.slice(0, 16).replace("T", " "))} UTC</div>
</header>
<div class="tiles">
  <div class="tile"><b>${rows.length}</b><span>checks</span></div>
  <div class="tile pass"><b>${c.pass}</b><span>pass</span></div>
  <div class="tile differs"><b>${c.differs}</b><span>differ</span></div>
  <div class="tile fails"><b>${c.fails}</b><span>fail</span></div>
  <div class="tile crashes"><b>${c.crashes}</b><span>crash</span></div>
  <div class="tile unsupported"><b>${c.unsupported}</b><span>documented unsupported</span></div>
</div>
<div class="sub" style="padding:0 16px">Plus ${surfaceRows.length} API members compared by presence: ${surfacePass} present, ${sc.fails} missing, ${sc.differs} different, ${sc.unsupported} documented unsupported.</div>
${video}
${bugs.length ? `<section class="card bugs"><h2>Bugs, worst first</h2><ol>${bugs.map((b) => `<li><b>${esc(b.title)}</b><small>${esc(b.ns)} · ${esc(b.severity)}</small>${esc(b.summary)}</li>`).join("")}</ol></section>` : ""}
<div class="filters" role="group" aria-label="Filter">
  <button type="button" aria-pressed="true" data-hide="1">Problems only</button>
  <button type="button" aria-pressed="false" data-hide="0">Everything</button>
</div>
<h3 class="section">Functional checks by namespace</h3>
${groups.map((g) => `<details class="${g.c.pass === g.list.length ? "all-pass" : ""}"${g.c.crashes + g.c.fails + g.c.differs ? " open" : ""}>
<summary><span class="ns">${esc(g.ns)}<small>${esc(CATALOG[g.ns]?.support ?? "")}${CATALOG[g.ns]?.note ? " · " + esc(CATALOG[g.ns].note) : ""}</small></span>${pills(g.c)}</summary>
<ul>${g.list.map(checkRow).join("")}</ul>
</details>`).join("\n")}
<h3 class="section">API members missing or different</h3>
${surfaceGroups.map((g) => `<details>
<summary><span class="ns">${esc(g.ns)}<small>${esc(CATALOG[g.ns]?.support ?? "")}</small></span>${pills(g.c)}</summary>
<ul>${g.list.map((r) => `<li class="row ${r.verdict}"><div class="head"><span class="v ${r.verdict}">${esc(LABEL[r.verdict])}</span><code>${esc(r.id)}</code><span class="ctx">${esc(r.ctx)}</span></div><div class="obs">Chrome: ${esc(r.chrome)} · ours: ${esc(r.tb)}</div></li>`).join("")}</ul>
</details>`).join("\n")}
<script>
for (const b of document.querySelectorAll(".filters button")) b.addEventListener("click", () => {
  document.body.classList.toggle("hide-pass", b.dataset.hide === "1");
  for (const o of document.querySelectorAll(".filters button")) o.setAttribute("aria-pressed", String(o === b));
});
</script>
</body>
</html>`;
}

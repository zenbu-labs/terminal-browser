const list = document.getElementById("list");
const sections = new Map();
let pass = 0, fail = 0;

function section(ns) {
  if (!sections.has(ns)) {
    const el = document.createElement("section");
    el.innerHTML = `<h2>${ns}<span>0</span></h2>`;
    list.prepend(el);
    sections.set(ns, { el, count: 0, failed: 0 });
  }
  return sections.get(ns);
}

function add(result, fresh) {
  const ns = result.id.split(/[.#]/)[0];
  const s = section(ns);
  const row = document.createElement("div");
  row.className = `row ${result.ok ? "ok" : "fail"}${fresh ? " new" : ""}`;
  row.innerHTML = `<i class="dot"></i><span></span>`;
  row.lastChild.textContent = `${result.id}${result.ctx !== "sw" ? ` [${result.ctx}]` : ""}${result.ok ? "" : ` — ${result.note}`}`;
  s.el.append(row);
  s.count++;
  if (!result.ok) s.failed++;
  s.el.querySelector("h2 span").textContent = s.failed ? `${s.count} · ${s.failed} failing` : `${s.count}`;
  if (fresh && list.firstChild !== s.el) list.prepend(s.el);
  result.ok ? pass++ : fail++;
  document.getElementById("pass").textContent = pass;
  document.getElementById("fail").textContent = fail;
  document.getElementById("total").textContent = pass + fail;
  document.getElementById("now").textContent = result.id;
}

const port = chrome.runtime.connect({ name: "god-results" });
port.onMessage.addListener((m) => {
  if (m.all) m.all.forEach((r) => add(r, false));
  if (m.result) add(m.result, true);
});
document.getElementById("where").textContent = navigator.userAgent.includes("Electron") ? "" : "";

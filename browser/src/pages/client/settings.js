import { api, h, live, mount, toggle } from "./dom.js";

const COPY = {
  title: "Settings",
  general: "General",
  appearance: "Appearance",
  advanced: "Advanced",
  privacy: "Privacy",
  clearData: "Clear browsing data",
  pages: "More",
  extensions: "Extensions",
  history: "History",
  downloads: "Downloads",
  bookmarks: "Bookmarks",
  about: "About terminal-browser",
  back: "← Settings",
  range: "Time range",
  ranges: [
    ["hour", "Last hour"],
    ["day", "Last 24 hours"],
    ["week", "Last 7 days"],
    ["month", "Last 4 weeks"],
    ["all", "All time"],
  ],
  kinds: [
    ["history", "Browsing history"],
    ["downloads", "Download history"],
    ["siteData", "Cookies and site data"],
    ["cache", "Cached images and files"],
  ],
  delete: "Delete data",
  deleting: "Deleting…",
  deleted: "Deleted",
  custom: "Custom",
};

const RANGE_MS = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 28 * 86400e3, all: 0 };

const route = location.pathname.startsWith("/clearBrowserData") ? "clear" : "main";
const state = { rows: [], error: "", clear: { range: "all", kinds: new Set(["history", "downloads", "siteData", "cache"]), status: "" } };

async function load() {
  if (route === "main") state.rows = await api.get();
  render();
}

async function apply(action) {
  try {
    state.rows = await action();
    state.error = "";
  } catch (error) {
    state.error = error.message;
  }
  render();
}

function control(row) {
  if (row.kind === "toggle") {
    const on = row.inverted ? row.value === "off" : row.value === "on";
    return toggle(on, (next) => apply(() => api.set(row.key, (row.inverted ? !next : next) ? "on" : "off")), row.label);
  }
  if (row.kind === "choice") {
    const known = row.choices.some((choice) => choice.value === row.value);
    return h(
      "select",
      { id: `setting-${row.key}`, onchange: (event) => apply(() => api.set(row.key, event.target.value)) },
      row.choices.map((choice) => h("option", { value: choice.value, selected: choice.value === row.value }, choice.name)),
      known ? null : h("option", { value: row.value, selected: true }, COPY.custom),
    );
  }
  return h("input", {
    id: `setting-${row.key}`,
    type: "text",
    value: row.value,
    onchange: (event) => apply(() => api.set(row.key, event.target.value)),
  });
}

function settingsSection(title, rows) {
  return h(
    "section",
    null,
    h("h2", null, title),
    h("ul", null, rows.map((row) => h("li", { class: "row" }, h("span", { class: "grow" }, row.label), control(row)))),
  );
}

function link(href, text) {
  return h("li", { class: "row" }, h("a", { href }, text));
}

function mainView() {
  return [
    h("header", null, h("h1", null, COPY.title)),
    state.error ? h("p", { class: "error" }, state.error) : null,
    settingsSection(COPY.general, state.rows.filter((row) => row.group === "general")),
    settingsSection(COPY.appearance, state.rows.filter((row) => row.group === "appearance")),
    h("section", null, h("h2", null, COPY.privacy), h("ul", null, link("terminal-browser://settings/clearBrowserData", COPY.clearData))),
    settingsSection(COPY.advanced, state.rows.filter((row) => row.group === "advanced")),
    h(
      "section",
      null,
      h("h2", null, COPY.pages),
      h(
        "ul",
        null,
        link("terminal-browser://extensions", COPY.extensions),
        link("terminal-browser://history", COPY.history),
        link("terminal-browser://downloads", COPY.downloads),
        link("terminal-browser://bookmarks", COPY.bookmarks),
        link("terminal-browser://version", COPY.about),
      ),
    ),
  ];
}

async function clearData() {
  const clear = state.clear;
  clear.status = COPY.deleting;
  render();
  const span = RANGE_MS[clear.range];
  try {
    await api.clearData({ kinds: [...clear.kinds], since: span ? Date.now() - span : 0 });
    clear.status = COPY.deleted;
  } catch (error) {
    clear.status = error.message;
  }
  render();
}

function clearView() {
  const clear = state.clear;
  return [
    h("p", null, h("a", { href: "terminal-browser://settings" }, COPY.back)),
    h("header", null, h("h1", null, COPY.clearData)),
    h(
      "div",
      { class: "row" },
      h("span", { class: "grow" }, COPY.range),
      h(
        "select",
        { onchange: (event) => { clear.range = event.target.value; } },
        COPY.ranges.map(([value, label]) => h("option", { value, selected: value === clear.range }, label)),
      ),
    ),
    COPY.kinds.map(([kind, label]) =>
      h(
        "label",
        { class: "row label" },
        h("input", {
          type: "checkbox",
          checked: clear.kinds.has(kind),
          onchange: (event) => {
            if (event.target.checked) clear.kinds.add(kind);
            else clear.kinds.delete(kind);
            render();
          },
        }),
        label,
      ),
    ),
    h(
      "div",
      { class: "row" },
      h("button", { class: "danger", disabled: clear.kinds.size === 0 || clear.status === COPY.deleting, onclick: clearData }, COPY.delete),
      h("span", { class: "muted" }, clear.status === COPY.deleting ? "" : clear.status),
    ),
  ];
}

function render() {
  mount(route === "clear" ? clearView() : mainView());
}

live(load);
